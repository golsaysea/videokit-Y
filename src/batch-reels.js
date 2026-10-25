/**
 * batch-reels.js — 批量Reels模块主逻辑
 * 
 * 完整移植自 AutoSub_v8 SubtitleStylePanel + FrameRenderer
 * 
 * 功能：
 * - 任务管理 (添加视频+SRT、自动配对、拖拽)
 * - 实时 Canvas 字幕预览 (含动画)
 * - 样式参数双向绑定 (所有 AutoSub 参数)
 * - 预设管理 (保存/加载/删除/导入/导出)
 * - 批量导出 (通过 IPC 调用 FFmpeg)
 */

// ═══════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════

const _reelsState = {
    tasks: [],
    selectedIdx: -1,
    targetWidth: 1080,
    targetHeight: 1920,
    renderer: null,

    previewRAF: null,
    previewFadeVideo: null,
    previewFadeVideoSrc: '',
    isExporting: false,
    lastExportOutputPath: '',
    pendingFiles: { backgrounds: [], audios: [], srts: [], txts: [] },
    backgroundLibrary: [],
    // Overlay interaction state
    overlaySelectedId: null,
    overlayDrag: null,        // { ovId, startX, startY, origX, origY, handle: null|'tl'|'tr'|'bl'|'br'|... }
    // Mock play state for items without media
    mockPlaying: false,
    mockPausedTime: 0,
    mockStartTime: 0,
    previewSeekLock: null,
    // AI watermarks
    watermarks: [],
    // Global subtitle style (when apply-all is enabled)
    globalSubtitleStyle: null,
    // 最近一次用户确认的字幕样式作用域；用于识别“全部 → 独立”的交接。
    lastSubtitleStyleScope: '',
    // Hook preview state
    hookVideoReady: false,
    hookDuration: 0,
    hookPhase: false, // true = currently in hook phase during playback
    // Content Video Image Sequence Cache
    cvSequence: { path: '', files: [], loadedImages: {} },
    previewMultiBg: { taskId: '', clipIndex: -1, path: '', image: null },
    folderQueueCollapsed: {},
};
window._reelsState = _reelsState;

// 顶部时间线工具栏的切刀：对普通片段和覆层都走编辑器同一套切分逻辑。
// 覆层会由 onClipSplit 转为多个显示区间，因此后续可分别调整或删除。
window.reelsSplitTimelineAtPlayhead = function() {
    const editor = _reelsState.timelineEditor;
    if (!editor) return;
    const nextActive = !editor._bladeTool;
    editor.setBladeTool(nextActive);
    const button = document.getElementById('reels-timeline-blade');
    if (button) {
        button.style.background = nextActive ? 'rgba(239,68,68,.48)' : 'rgba(239,68,68,.18)';
        button.style.color = nextActive ? '#fff' : '#fecaca';
        button.textContent = nextActive ? '✂️ 切刀已开启' : '✂️ 切刀';
    }
    if (typeof showToast === 'function') showToast(nextActive ? '切刀已开启：直接单击片段要切开的位置；Esc 退出' : '已退出切刀', 'info');
};

const REELS_DEFAULT_PRESET_KEY = 'reels_default_preset_name';
const REELS_EXPORT_RESUME_KEY = 'videokit_reels_export_resume_v1';
const REELS_TASK_NAME_DISPLAY_KEY = 'videokit_reels_task_name_display_v1';
const REELS_EXPORT_RECYCLE_EVERY_DEFAULT = 0;
const REELS_WATERMARK_STORAGE_KEY = 'reels_watermarks';
const REELS_BACKGROUND_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp']);
const REELS_AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']);
const REELS_TXT_EXTS = new Set(['txt']);
const REELS_MATCH_STOPWORDS = new Set([
    'srt', 'sub', 'subtitle', 'source', 'src', 'audio', 'voice', 'vo',
    'en', 'cn', 'zh', 'ja', 'jp', 'ko', 'kr', 'es', 'de', 'fr', 'pt', 'it', 'ru', 'ar',
    '720p', '1080p', '4k', 'hd', 'fhd', 'mp4', 'mp3', 'wav', 'aac', 'h264', 'h265', 'hevc', 'x264', 'x265',
    'trim', 'cut', 'clip', 'final', 'v1', 'v2', 'v3', 'edit', 'edited', 'render', 'copy', 'out', 'output'
]);

const REELS_FONT_PRESETS = {
    bebashook: {
        label: 'Bebas Neue 标题粗体',
        font_family: 'Bebas Neue',
        font_weight: 800,
        fontsize: 86,
        bold: true,
        italic: false,
        letter_spacing: 1,
    },
    oswald_clean: {
        label: 'Oswald 干净信息流',
        font_family: 'Oswald',
        font_weight: 700,
        fontsize: 74,
        bold: true,
        italic: false,
        letter_spacing: 0,
    },
    montserrat_modern: {
        label: 'Montserrat 现代通用',
        font_family: 'Montserrat',
        font_weight: 700,
        fontsize: 72,
        bold: true,
        italic: false,
        letter_spacing: 0,
    },
    playfair_story: {
        label: 'Playfair Display 叙事感',
        font_family: 'Playfair Display',
        font_weight: 700,
        fontsize: 70,
        bold: true,
        italic: false,
        letter_spacing: 0,
    },
    noto_sans_cn: {
        label: 'Noto Sans SC 中文清晰',
        font_family: 'Noto Sans SC',
        font_weight: 700,
        fontsize: 70,
        bold: true,
        italic: false,
        letter_spacing: 0,
    },
    noto_serif_cn: {
        label: 'Noto Serif SC 中文衬线',
        font_family: 'Noto Serif SC',
        font_weight: 700,
        fontsize: 68,
        bold: true,
        italic: false,
        letter_spacing: 0,
    },
};

const REELS_ANIMATION_PRESETS = {
    classic_fade: {
        label: 'Classic Clean · 淡入淡出',
        anim_in_type: 'fade',
        anim_in_duration: 0.28,
        anim_out_type: 'fade',
        anim_out_duration: 0.22,
    },
    bold_pop: {
        label: 'Bold Punch · 弹出强调',
        anim_in_type: 'pop',
        anim_in_duration: 0.2,
        anim_out_type: 'fade',
        anim_out_duration: 0.18,
        letter_jump_scale: 1.35,
    },
    karaoke_sweep: {
        label: 'Karaoke Sweep · 卡拉OK',
        anim_in_type: 'fade',
        anim_in_duration: 0.18,
        anim_out_type: 'fade',
        anim_out_duration: 0.16,
        karaoke_highlight: true,
    },
    pop_word: {
        label: 'Pop Word · 逐字放大',
        anim_in_type: 'letter_jump',
        anim_in_duration: 0.26,
        anim_out_type: 'fade',
        anim_out_duration: 0.2,
        letter_jump_scale: 1.6,
    },
    word_pop_random: {
        label: 'Word Pop Random · 逐词弹出(随机)',
        anim_in_type: 'word_pop_random',
        anim_in_duration: 0.24,
        anim_out_type: 'fade',
        anim_out_duration: 0.2,
        word_pop_random_min_scale: 0.7,
        word_pop_random_max_scale: 1.34,
        word_pop_random_duration: 0.24,
        word_pop_random_unread_opacity: 0.0,
        word_pop_random_read_opacity: 1.0,
    },
    word_pop_random_pulse: {
        label: 'Word Pop Pulse · 逐词弹出(回弹)',
        anim_in_type: 'word_pop_random_pulse',
        anim_in_duration: 0.24,
        anim_out_type: 'fade',
        anim_out_duration: 0.2,
        word_pop_random_pulse_min_scale: 1.08,
        word_pop_random_pulse_max_scale: 1.40,
        word_pop_random_pulse_duration: 0.24,
        word_pop_random_unread_opacity: 0.0,
        word_pop_random_read_opacity: 1.0,
    },
    typewriter_story: {
        label: 'Typewriter · 打字机',
        anim_in_type: 'typewriter',
        anim_in_duration: 0.42,
        anim_out_type: 'fade',
        anim_out_duration: 0.26,
        typewriter_reveal_type: 'word',
        tw_unrevealed_opacity: 0,
    },
    bounce_fun: {
        label: 'Bounce · 逐字弹跳',
        anim_in_type: 'char_bounce',
        anim_in_duration: 0.3,
        anim_out_type: 'fade',
        anim_out_duration: 0.2,
        char_bounce_height: 24,
    },
    metro_beat: {
        label: 'Rhythm Beat · 节奏逐词',
        anim_in_type: 'metronome',
        anim_in_duration: 0.28,
        anim_out_type: 'fade',
        anim_out_duration: 0.2,
        metronome_bpm: 128,
        metro_unread_opacity: 100,
    },
    slide_up_clean: {
        label: 'Slide Up · 上滑入场',
        anim_in_type: 'slide_up',
        anim_in_duration: 0.24,
        anim_out_type: 'slide_down',
        anim_out_duration: 0.2,
    },
    slide_lr: {
        label: 'Slide Left/Right · 横向切入',
        anim_in_type: 'slide_left',
        anim_in_duration: 0.25,
        anim_out_type: 'slide_right',
        anim_out_duration: 0.22,
    },
    floating_soft: {
        label: 'Floating · 轻漂浮',
        anim_in_type: 'floating',
        anim_in_duration: 0.32,
        anim_out_type: 'fade',
        anim_out_duration: 0.24,
        floating_amplitude: 10,
        floating_period: 2.4,
    },
    flash_hook: {
        label: 'Flash Highlight · 闪光开场',
        anim_in_type: 'flash_highlight',
        anim_in_duration: 0.2,
        anim_out_type: 'fade',
        anim_out_duration: 0.18,
        flash_color: '#FFFFFF',
    },
    glow_cinematic: {
        label: 'Holy Glow · 圣光字幕',
        anim_in_type: 'holy_glow',
        anim_in_duration: 0.42,
        anim_out_type: 'fade',
        anim_out_duration: 0.28,
        holy_glow_color: '#FFFFAA',
        holy_glow_radius: 8,
    },
    blur_focus: {
        label: 'Blur To Sharp · 聚焦清晰',
        anim_in_type: 'blur_sharp',
        anim_in_duration: 0.35,
        anim_out_type: 'fade',
        anim_out_duration: 0.24,
        blur_sharp_max: 22,
    },
    bullet_reveal: {
        label: 'Bullet Reveal · 逐行出现',
        anim_in_type: 'bullet_reveal',
        anim_in_duration: 0.28,
        anim_out_type: 'fade',
        anim_out_duration: 0.22,
    },
    box_wipe: {
        label: 'Box Wipe · 底条逐行擦除',
        anim_in_type: 'box_wipe',
        anim_in_duration: 0,
        anim_out_type: 'none',
        anim_out_duration: 0,
        use_box: true,
        box_adaptive_width: true,
        box_connected: false,
        box_wipe_enabled: true,
    },
    zoom_typewriter: {
        label: 'Zoom Typewriter · 远景打字推进',
        anim_in_type: 'zoom_typewriter',
        anim_in_duration: 0.35,
        anim_out_type: 'none',
        anim_out_duration: 0,
        typewriter_reveal_type: 'char',
        tw_unrevealed_opacity: 0,
    },
};

let _reelsHotkeyBound = false;

// ═══════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    _initReelsModule();
});

// Update dataset.rawValue whenever any subtitle-related input element changes
document.addEventListener('input', (e) => {
    if (e.target && e.target.id && e.target.id.startsWith('reels-')) {
        e.target.dataset.rawValue = e.target.value;
    }
});

function _initReelsModule() {
    const canvas = document.getElementById('reels-preview-canvas');
    if (canvas) {
        canvas.width = _reelsState.targetWidth || 1080;
        canvas.height = _reelsState.targetHeight || 1920;
        _reelsState.renderer = new ReelsCanvasRenderer(canvas);
    }

    
    // Probe GPU
    setTimeout(async () => {
        try {
            const gpuNameEl = document.getElementById('reels-gpu-name');
            const gpuCheckbox = document.getElementById('reels-use-gpu');
            if (gpuNameEl && window.electronAPI && window.electronAPI.reelsComposeWysiwyg) {
                gpuNameEl.textContent = '(探测中...)';
                const gpuInfo = await window.electronAPI.reelsComposeWysiwyg('probe-gpu');
                if (gpuInfo && !gpuInfo.error) {
                    if (gpuInfo.available) {
                        gpuNameEl.textContent = `(${gpuInfo.name || 'API加载中'})`;
                        gpuNameEl.style.color = '#38bdf8';
                        if (gpuCheckbox && !gpuCheckbox.disabled) gpuCheckbox.checked = true;
                    } else {
                        gpuNameEl.textContent = `(${gpuInfo.name || 'CPU'})`;
                        gpuNameEl.style.color = '#f87171';
                        if (gpuCheckbox) {
                            gpuCheckbox.checked = false;
                        }
                    }
                } else {
                    gpuNameEl.textContent = '(需重启客户端生效)';
                    gpuNameEl.style.color = '#f87171';
                }
            }
        } catch (e) {
            console.warn('Probe GPU failed', e);
        }
    }, 1500);

    const videoInput = document.getElementById('reels-video-input');
    const audioInput = document.getElementById('reels-audio-input');
    const srtInput = document.getElementById('reels-srt-input');
    const txtInput = document.getElementById('reels-txt-input');
    const folderInput = document.getElementById('reels-folder-input');
    if (videoInput) videoInput.addEventListener('change', _onVideoFilesSelected);
    if (audioInput) audioInput.addEventListener('change', _onAudioFilesSelected);
    if (srtInput) srtInput.addEventListener('change', _onSrtFilesSelected);
    if (txtInput) txtInput.addEventListener('change', _onTxtFilesSelected);
    if (folderInput) folderInput.addEventListener('change', _onFolderFilesSelected);

    const taskList = document.getElementById('reels-task-list');
    if (taskList) {
        taskList.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            taskList.style.borderColor = 'var(--accent-color)';
            taskList.style.backgroundColor = 'rgba(233, 69, 96, 0.10)';
            taskList.style.boxShadow = '0 0 0 2px rgba(233, 69, 96, 0.22) inset';
        });
        taskList.addEventListener('dragleave', () => {
            taskList.style.borderColor = '';
            taskList.style.backgroundColor = '';
            taskList.style.boxShadow = '';
        });
        taskList.addEventListener('drop', _onTaskListDrop);
    }

    const seekBar = document.getElementById('reels-preview-seek');
    if (seekBar) {
        seekBar.addEventListener('input', _onSeek);
        seekBar.addEventListener('change', _onSeek);
    }
    const previewLoopEl = document.getElementById('reels-preview-loop');
    if (previewLoopEl) previewLoopEl.addEventListener('change', reelsOnPreviewLoopModeChange);
    const voiceVolumeEl = document.getElementById('reels-voice-volume');
    const bgVolumeEl = document.getElementById('reels-bg-volume');
    const bindMix = (el) => {
        if (!el) return;
        el.addEventListener('input', _applyPreviewAudioMix);
        el.addEventListener('change', _applyPreviewAudioMix);
    };
    bindMix(voiceVolumeEl);
    bindMix(bgVolumeEl);
    _initReelsExportSettingsPersistence();
    _initExportSettingSliders();
    if (bgVolumeEl) {
        const bgVolumeRangeGlobalEl = document.getElementById('reels-bg-volume-range-global');
        const syncInheritedBgVolumeUI = () => {
            const task = (typeof _getSelectedTask === 'function') ? _getSelectedTask() : null;
            const hasCustomBgVol = task && task.bgVideoVolume != null && parseFloat(task.bgVideoVolume) !== 100;
            if (hasCustomBgVol) return;
            const value = _getGlobalBgVolumePercent();
            const range = document.getElementById('reels-bg-volume-range');
            const num = document.getElementById('reels-bg-volume-num');
            if (range) {
                range.value = value;
                range.dataset.isCustom = 'false';
            }
            if (num) {
                num.value = value;
                num.dataset.isCustom = 'false';
            }
        };
        bgVolumeEl.addEventListener('input', syncInheritedBgVolumeUI);
        bgVolumeEl.addEventListener('change', syncInheritedBgVolumeUI);
        if (bgVolumeRangeGlobalEl) {
            bgVolumeRangeGlobalEl.addEventListener('input', syncInheritedBgVolumeUI);
            bgVolumeRangeGlobalEl.addEventListener('change', syncInheritedBgVolumeUI);
        }
    }

    // ── 任务级背景音量控制自定义标记 ──
    const bgVolRange = document.getElementById('reels-bg-volume-range');
    const bgVolNum = document.getElementById('reels-bg-volume-num');
    if (bgVolRange && bgVolNum) {
        const markCustom = () => {
            bgVolRange.dataset.isCustom = 'true';
            bgVolNum.dataset.isCustom = 'true';
            _applyPreviewAudioMix();
        };
        bgVolRange.addEventListener('input', markCustom);
        bgVolNum.addEventListener('input', markCustom);
    }

    // ── 配乐层全局音量与侧边栏联动 ──
    const bgmVolumeEl = document.getElementById('reels-bgm-volume');
    if (bgmVolumeEl) {
        const bgmVolumeRangeGlobalEl = document.getElementById('reels-bgm-volume-range');
        const syncInheritedBgmVolumeUI = () => {
            const task = (typeof _getSelectedTask === 'function') ? _getSelectedTask() : null;
            const hasCustomBgmVol = task && task.bgmVolume != null;
            const value = _getGlobalBgmVolumePercent();
            const range = document.getElementById('reels-bgm-task-volume-range');
            const num = document.getElementById('reels-bgm-task-volume-num');
            if (!hasCustomBgmVol) {
                if (range) {
                    range.value = value;
                    range.dataset.isCustom = 'false';
                }
                if (num) {
                    num.value = value;
                    num.dataset.isCustom = 'false';
                }
            }
            if (typeof _applyPreviewAudioMix === 'function') _applyPreviewAudioMix();
        };
        bgmVolumeEl.addEventListener('input', syncInheritedBgmVolumeUI);
        bgmVolumeEl.addEventListener('change', syncInheritedBgmVolumeUI);
        if (bgmVolumeRangeGlobalEl) {
            bgmVolumeRangeGlobalEl.addEventListener('input', syncInheritedBgmVolumeUI);
            bgmVolumeRangeGlobalEl.addEventListener('change', syncInheritedBgmVolumeUI);
        }
    }

    // ── 任务级配乐音量控制自定义标记 ──
    const bgmVolRange = document.getElementById('reels-bgm-task-volume-range');
    const bgmVolNum = document.getElementById('reels-bgm-task-volume-num');
    if (bgmVolRange && bgmVolNum) {
        const markBgmCustom = () => {
            bgmVolRange.dataset.isCustom = 'true';
            bgmVolNum.dataset.isCustom = 'true';
            const task = (typeof _getSelectedTask === 'function') ? _getSelectedTask() : null;
            const value = parseFloat(bgmVolNum.value);
            if (task && Number.isFinite(value)) task.bgmVolume = value;
            _applyPreviewAudioMix();
        };
        bgmVolRange.addEventListener('input', markBgmCustom);
        bgmVolNum.addEventListener('input', markBgmCustom);
    }

    // ── 混响 / 立体声控件 ──
    const reverbIds = ['reels-reverb-enabled', 'reels-reverb-preset', 'reels-reverb-mix', 'reels-stereo-width', 'reels-audio-fx-target'];
    for (const rid of reverbIds) {
        const el = document.getElementById(rid);
        if (el) {
            el.addEventListener('change', _applyPreviewAudioMix);
            el.addEventListener('input', _applyPreviewAudioMix);
        }
    }

    const video = document.getElementById('reels-preview-video');
    if (video) {
        video.addEventListener('timeupdate', _onVideoTimeUpdate);
        video.addEventListener('loadedmetadata', _onVideoLoaded);
    }
    const audio = document.getElementById('reels-preview-audio');
    if (audio) {
        audio.addEventListener('timeupdate', _onAudioTimeUpdate);
        audio.addEventListener('loadedmetadata', _onAudioLoaded);
        audio.addEventListener('ended', () => {
            if (_isPreviewLoopEnabled()) return;
            const video = document.getElementById('reels-preview-video');
            if (video) video.pause();
            const fadeVideo = _reelsState.previewFadeVideo;
            if (fadeVideo) fadeVideo.pause();
            // 同步暂停 BGM
            const bgmAudio = _reelsState._bgmAudioEl;
            if (bgmAudio) bgmAudio.pause();
            const btn = document.getElementById('reels-preview-play');
            if (btn) btn.textContent = '▶️';
        });
    }
    const cvVideo = document.getElementById('reels-preview-contentvideo');
    if (cvVideo) {
        cvVideo.addEventListener('timeupdate', _onCvVideoTimeUpdate);
        cvVideo.addEventListener('loadedmetadata', _onCvVideoLoaded);
        cvVideo.addEventListener('ended', () => {
            if (_isPreviewLoopEnabled()) return;
            const video = document.getElementById('reels-preview-video');
            if (video) video.pause();
            const fadeVideo = _reelsState.previewFadeVideo;
            if (fadeVideo) fadeVideo.pause();
            const audio = document.getElementById('reels-preview-audio');
            if (audio) audio.pause();
            const bgmAudio = _reelsState._bgmAudioEl;
            if (bgmAudio) bgmAudio.pause();
            const btn = document.getElementById('reels-preview-play');
            if (btn) btn.textContent = '▶️';
        });
    }

    // ═══ 创建 BGM 音频元素（隐藏） ═══
    if (!_reelsState._bgmAudioEl) {
        const bgmEl = document.createElement('audio');
        bgmEl.id = 'reels-preview-bgm';
        bgmEl.style.display = 'none';
        bgmEl.loop = _isPreviewLoopEnabled();
        document.body.appendChild(bgmEl);
        _reelsState._bgmAudioEl = bgmEl;
    }
    _applyPreviewLoopMode();

    _reelsRefreshPresetList();
    _reelsApplyDefaultPreset();
    _reelsState.globalSubtitleStyle = _cloneSubtitleStyle(_readStyleFromUI());
    _initReelsFontPresetUI();
    _initReelsAnimationPresetUI();

    // ═══ 字体管理器初始化 ═══
    _initFontManager();

    // ═══ NLE UI 组件初始化 ═══

    // 时间线编辑器
    const tlContainer = document.getElementById('reels-timeline-container');
    if (tlContainer && typeof ReelsTimelineEditor !== 'undefined') {
        _reelsState.timelineEditor = new ReelsTimelineEditor(tlContainer);
        const historyStepsEl = document.getElementById('reels-history-steps');
        const historyMemoryEl = document.getElementById('reels-history-memory');
        const syncHistorySettingsUi = () => {
            if (typeof window.reelsGetHistorySettings !== 'function') return;
            const settings = window.reelsGetHistorySettings();
            if (historyStepsEl) historyStepsEl.value = String(settings.maxSteps);
            if (historyMemoryEl) historyMemoryEl.value = String(settings.maxBytes);
        };
        syncHistorySettingsUi();
        const saveHistorySettings = () => {
            if (typeof window.reelsSetHistorySettings !== 'function') return;
            const settings = window.reelsSetHistorySettings({
                maxSteps: Number(historyStepsEl?.value),
                maxBytes: Number(historyMemoryEl?.value),
            });
            const status = document.getElementById('reels-export-status');
            if (status) status.textContent = `↶ 已设置撤销历史：${settings.maxSteps} 步 / ${Math.round(settings.maxBytes / 1024 / 1024)} MB`;
        };
        if (historyStepsEl && !historyStepsEl.dataset.bound) {
            historyStepsEl.dataset.bound = 'true';
            historyStepsEl.addEventListener('change', saveHistorySettings);
        }
        if (historyMemoryEl && !historyMemoryEl.dataset.bound) {
            historyMemoryEl.dataset.bound = 'true';
            historyMemoryEl.addEventListener('change', saveHistorySettings);
        }
        _reelsState.timelineEditor.onSeek = (t, type) => {
            if (window.ReelsPreviewV2?.isOpen?.()) {
                window.ReelsPreviewV2.seek(window.ReelsPreviewV2.timelineToAbsolute(t));
            } else {
                const task = _getSelectedTask();
                const hookDur = _reelsState.hookDuration || 0;
                const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
                const offsetDur = hookDur + coverDur;
                const aDurScale = (task && task.audioDurScale) ? (task.audioDurScale / 100) : 1;
                const absoluteTarget = (t * aDurScale) + offsetDur;
                _onSeek({ absoluteTarget, type });
            }
        };
        _reelsState.timelineEditor.onClipSelect = (ti, ci, clip) => {
            console.log('[Timeline] Selected clip', ti, ci, clip);
            // 选中片段只改变编辑焦点，绝不改写播放头。此前点击某个字幕/素材块
            // 会把播放头强制跳到片段中点，和时间尺点击/拖动形成竞争，审核时很
            // 难判断当前预览究竟对应哪个时间。需要定位时直接点击时间尺即可。
            if (clip?._timelineRole === 'insert_video') {
                _showInsertClipInspector(clip);
            } else {
                _hideInsertClipInspector();
            }
            if (clip?._timelineRole === 'overlay' || clip?._overlayId) {
                _reelsState.overlaySelectedId = clip._overlayId || clip._timelineClipId;
                if (_reelsState.overlayProxy?.overlayMgr) {
                    _reelsState.overlayProxy.overlayMgr.selectedId = _reelsState.overlaySelectedId;
                }
                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                if (typeof window.reelsRenderOverlayListUI === 'function') window.reelsRenderOverlayListUI();
            }
        };
        _reelsState.timelineEditor.onTrackVisibilityChange = (trackIdx, visible, track) => {
            const task = _getSelectedTask();
            if (!task) return;
            const isInsert = track.role === 'insert_video' || (track.name && track.name.includes('插入')) || track.clips?.some(c => c._timelineRole === 'insert_video');
            const isBg = !isInsert && (track.role === 'background' || (track.name && track.name.includes('背景')) || (track.type === 'video' && !track.name?.includes('插入')));

            if (track._overlayId) {
                // 单个覆层卡片轨
                const activeOverlays = (_reelsState.overlayProxy?.overlayMgr?.overlays) || task.overlays || [];
                const ov = activeOverlays.find(o => o.id === track._overlayId);
                if (ov) {
                    ov.disabled = !visible;
                    _syncCurrentOverlayEditorToSelectedTask();
                    if (_reelsState.overlayPanel) _reelsState.overlayPanel._refreshList?.();
                }
            } else if (isInsert) {
                // 插入素材轨
                task.insertClipsDisabled = !visible;
                if (Array.isArray(task.insertClips)) {
                    task.insertClips.forEach(item => { item.disabled = !visible; });
                }
            } else if (track.type === 'subs') {
                // 字幕轨
                task.showSubtitle = visible;
                const subtitleToggle = document.getElementById('reels-subtitle-toggle');
                if (subtitleToggle) {
                    subtitleToggle.checked = visible;
                }
            } else if (isBg) {
                // 背景视频轨
                task.bgDisabled = !visible;
            }

            // 同步时间线底层模型的轨道 visible 状态
            const timeline = window.ReelsRenderPlan?.ensureTimeline?.(task);
            if (timeline) {
                const tlTrack = timeline.tracks.find(t => t.id === track._timelineTrackId || t.type === track.type);
                if (tlTrack) tlTrack.visible = visible;
            }

            reelsUpdatePreview();
            if (typeof window.ReelsPreviewV2?.render === 'function') window.ReelsPreviewV2.render();
            if (typeof window.ReelsPreviewV2?.redraw === 'function') window.ReelsPreviewV2.redraw();
        };
        const syncEditedSubtitleSegment = (seg, newText) => {
            const text = String(newText || '');
            seg.text = text;
            seg.edited_text = text;

            const newWords = text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
            if (!Array.isArray(seg.words) || seg.words.length === 0) return;

            if (newWords.length === seg.words.length) {
                seg.words = seg.words.map((w, i) => ({ ...w, word: newWords[i] }));
                return;
            }

            const start = Number(seg.start) || 0;
            const end = Number(seg.end) || start;
            const dur = Math.max(0.001, end - start);
            seg.words = newWords.map((word, i) => ({
                word,
                start: start + dur * (i / Math.max(1, newWords.length)),
                end: start + dur * ((i + 1) / Math.max(1, newWords.length)),
            }));
        };

        // 绑定片段拖拽调整事件 (onClipChange)
        let _clipDragTimer = null;
        // 每次拖动只保存“拖动前”和“拖动后”两个状态。不能在 mousemove
        // 中存历史，否则一次调整会占满用户设置的 100/300/1000 步额度。
        _reelsState.timelineEditor.onEditStart = () => {
            if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
        };
        _reelsState.timelineEditor.onEditEnd = () => {
            if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
            // 重新投影同一份 timeline：把已移动的绑定原声和后续波纹片段同步
            // 回画布，但 render-plan 不会覆盖用户刚刚完成的编辑。
            const task = _getSelectedTask();
            if (task) {
                // 插入素材片段的删除/拆分发生在编辑器的显示模型中；在重绘前
                // 回写到当前任务，确保切换任务、保存工程时不会丢失。
                window.ReelsRenderPlan?.syncInsertClipsFromTimeline?.(task);
                _updateTimelineForTask(task);
            }
        };
        _reelsState.timelineEditor.onFillGap = () => {
            const task = _getSelectedTask();
            if (!task) return;
            const subtitleDuration = Array.isArray(task.segments) && task.segments.length
                ? Math.max(0, ...task.segments.map(s => Number(s.end) || 0))
                : 0;
            const outputDuration = Math.max(subtitleDuration, _getAudioDuration(task), _getVideoDuration(task), _getContentVideoDuration(task), Number(task.duration) || 0, task.customDuration || 0, 1);
            if (window.ReelsRenderPlan?.fillBackgroundLoops(task, { duration: outputDuration })) {
                _updateTimelineForTask(task);
                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
                const status = document.getElementById('reels-export-status');
                if (status) status.textContent = `🔄 已自动补充背景循环画面至 ${outputDuration.toFixed(1)}s！`;
            }
        };
        _reelsState.timelineEditor.onClipChange = (trackIdx, clipIdx, clip, editOptions = {}) => {
            const task = _getSelectedTask();
            if (!task) return;
            // 覆层的 id 可能是数字 0；不能用 truthy 判断，否则这类覆层在时间线
            // 中拖动后不会回写，视觉上就像“不能直接拖拽”。
            if (clip && (clip._timelineClipId != null || clip._overlayId != null) && window.ReelsRenderPlan?.applyEditorClip(task, clip, editOptions)) {
                if (!_clipDragTimer && typeof reelsUpdatePreview === 'function') {
                    _clipDragTimer = setTimeout(() => {
                        reelsUpdatePreview();
                        _clipDragTimer = null;
                    }, 50);
                }
                return;
            }
            if (!task.segments) return;
            const track = _reelsState.timelineEditor._tracks[trackIdx];
            if (track && track.type === 'subs') {
                const segIdx = clip._segIdx != null ? clip._segIdx : clipIdx;
                if (segIdx >= 0 && segIdx < task.segments.length) {
                    const seg = task.segments[segIdx];
                    // 用户拖动过字幕时间后，后续自动剪辑成片同步不得再静默用
                    // 新 SRT 覆盖当前字幕。
                    task._manualSubtitleEdits = true;
                    // 更新段落时间
                    seg.start = clip.start;
                    seg.end = clip.end;
                    
                    // 比例缩放内部每个字的时间，确保逐字高亮动画能对齐
                    if (seg.words && seg.words.length > 0) {
                        const dur = Math.max(0.001, seg.end - seg.start);
                        seg.words.forEach((w, i) => {
                            w.start = seg.start + dur * (i / seg.words.length);
                            w.end = seg.start + dur * ((i + 1) / seg.words.length);
                        });
                    }
                    
                    // 节流更新预览画布，避免拖拽卡顿
                    if (!_clipDragTimer && typeof reelsUpdatePreview === 'function') {
                        _clipDragTimer = setTimeout(() => {
                            reelsUpdatePreview();
                            _clipDragTimer = null;
                        }, 50);
                    }
                }
            }
        };
        _reelsState.timelineEditor.onTrackOrderChange = (trackIdx, direction, editorTrack, targetTrack) => {
            const task = _getSelectedTask();
            if (!task) return;
            // 覆层轨和插入素材轨是同一合成栈。以前后面的绑定覆盖了这里，
            // 时间线会移动但画面顺序不会改变。
            if (window.ReelsRenderPlan?.moveCompositedOverlay?.(task, editorTrack, targetTrack)) {
                _syncCurrentOverlayEditorToSelectedTask();
                if (_reelsState.overlayPanel) _reelsState.overlayPanel._refreshList?.();
                _updateTimelineForTask(task);
                if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                if (typeof window.ReelsPreviewV2?.render === 'function') window.ReelsPreviewV2.render();
                return;
            }
            const timeline = task && window.ReelsRenderPlan?.ensureTimeline?.(task);
            const track = timeline?.tracks?.find(item => item.id === editorTrack._timelineTrackId);
            if (!track) return;
            if (direction === 'up') timeline.moveTrackUp(track);
            else timeline.moveTrackDown(track);
            window.ReelsRenderPlan.syncLegacyFields(task);
            _updateTimelineForTask(task);
            if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
            if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
        };
        _reelsState.timelineEditor.onClipContextMenu = (trackIdx, clipIdx, clip) => {
            const extraItems = [];
            const task = _getSelectedTask();
            if (!task || !clip) return [];

            const role = clip._timelineRole || '';
            const track = _reelsState.timelineEditor._tracks[trackIdx];

            // 1. 预览此片段
            extraItems.push({
                icon: '▶️',
                text: '从此处开始预览',
                action: () => {
                    _reelsState.timelineEditor.setPlayhead(clip.start);
                    if (typeof _previewPlay === 'function') _previewPlay(clip.start);
                },
            });

            // 2. 视频轨操作 (背景/内容视频/插入素材)
            if (track?.type === 'video' || role === 'background' || role === 'content_video' || role === 'insert_video') {
                extraItems.push({
                    icon: '🎬',
                    text: '替换此视频素材文件…',
                    action: async () => {
                        const path = await _pickSingleFile('替换素材视频', ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);
                        if (!path) return;
                        const timeline = window.ReelsRenderPlan?.ensureTimeline(task);
                        const found = timeline?.findClip(clip._timelineClipId);
                        if (found) {
                            const source = new window.ReelsTimeline.MediaSource(path);
                            source.duration = Math.max(found.clip.outT, 1.5);
                            timeline.sources[source.id] = source;
                            found.clip.sourceId = source.id;
                        }
                        if (role === 'background') {
                            task.bgPath = path;
                            task.videoPath = path;
                        } else if (role === 'content_video') {
                            task.contentVideoPath = path;
                        }
                        window.ReelsRenderPlan?.syncLegacyFields(task);
                        _updateTimelineForTask(task);
                        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
                    },
                });
            }

            // 覆层可在同一轨道上拥有多个不连续显示区间。每个紫色块就是一次
            // 出现；拖动/裁切任一块只修改它自己的入点和出点。
            if (track?.type === 'overlay' || role === 'overlay') {
                const overlays = (_reelsState.overlayProxy?.overlayMgr?.overlays) || task.overlays || [];
                const overlay = overlays.find(item => item.id === clip._overlayId);
                if (overlay) {
                    extraItems.push({
                        icon: '＋',
                        text: '新增一次显示区间（从播放头）',
                        action: () => {
                            const total = Math.max(0.2, Number(_reelsState.timelineEditor?._duration) || 10);
                            const start = Math.max(0, Math.min(total - 0.1, Number(_reelsState.timelineEditor?._playheadPos) || 0));
                            const ranges = Array.isArray(overlay.display_ranges) && overlay.display_ranges.length
                                ? overlay.display_ranges.map(range => ({ ...range }))
                                : [{ start: Number(overlay.start) || 0, end: Number(overlay.end) || Math.min(5, total) }];
                            ranges.push({ start, end: Math.min(total, start + 10) });
                            ranges.sort((a, b) => a.start - b.start);
                            overlay.display_ranges = ranges;
                            overlay.start = ranges[0].start;
                            overlay.end = ranges[ranges.length - 1].end;
                            _updateTimelineForTask(task);
                            if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                            if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
                        },
                    });
                    if (Array.isArray(overlay.display_ranges) && overlay.display_ranges.length > 1) {
                        extraItems.push({
                            icon: '🗑️',
                            text: '删除当前显示区间',
                            danger: true,
                            action: () => {
                                const rangeIndex = Number(clip._overlayRangeIndex) || 0;
                                overlay.display_ranges.splice(rangeIndex, 1);
                                overlay.display_ranges.sort((a, b) => a.start - b.start);
                                overlay.start = overlay.display_ranges[0].start;
                                overlay.end = overlay.display_ranges[overlay.display_ranges.length - 1].end;
                                _updateTimelineForTask(task);
                                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                                if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
                            },
                        });
                    }
                }
            }

            // 3. 字幕轨操作 (字幕编辑与替换)
            if (track?.type === 'subs' || role === 'subs') {
                extraItems.push({
                    icon: '✏️',
                    text: '编辑此句字幕文字与样式…',
                    action: () => {
                        const rect = _reelsState.timelineEditor._getClipScreenRect(trackIdx, clipIdx);
                        _reelsState.timelineEditor._openSubtitleEditor(trackIdx, clipIdx, clip, rect);
                    },
                });
                extraItems.push({
                    icon: '📄',
                    text: '导入/替换外部 SRT 字幕…',
                    action: async () => {
                        const path = await _pickSingleFile('选择 SRT 字幕文件', ['srt', 'vtt', 'ass']);
                        if (!path) return;
                        if (typeof loadSrtFileForTask === 'function') {
                            await loadSrtFileForTask(task, path);
                        } else if (window.electronAPI?.readFileText && typeof parseSRT === 'function') {
                            const srtContent = await window.electronAPI.readFileText(path);
                            const rawSegs = parseSRT(srtContent).map(seg => ({ ...seg, _timeUnit: 'sec' }));
                            task.segments = window.ReelsSubtitleProcessor
                                ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
                                : rawSegs;
                            task.srtPath = path;
                        }
                        _updateTimelineForTask(task);
                        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                    },
                });
            }

            // 4. 音频轨操作 (人声/配乐/原声)
            if (track?.type === 'audio' || track?.type === 'bgm' || role === 'voice' || role === 'bgm' || role === 'source_audio') {
                extraItems.push({
                    icon: '🎵',
                    text: '替换音频文件…',
                    action: async () => {
                        const path = await _pickSingleFile('选择音频文件', ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']);
                        if (!path) return;
                        if (role === 'bgm' || track?.type === 'bgm') {
                            task.bgmPath = path;
                        } else {
                            task.audioPath = path;
                        }
                        window.ReelsRenderPlan?.syncLegacyFields(task);
                        _updateTimelineForTask(task);
                        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
                    },
                });
            }

            return extraItems;
        };

        // 覆层轨使用真正的剪辑语义：S 切分紫色块会拆成两个显示区间；删除
        // 其中一个块只隐藏那一段，而不会删除整个覆层对象。
        _reelsState.timelineEditor.onClipSplit = (trackIdx, clipIdx, clip, timeSec) => {
            if (clip?._timelineRole !== 'overlay' || timeSec <= clip.start + 0.05 || timeSec >= clip.end - 0.05) return false;
            const task = _getSelectedTask();
            const overlays = (_reelsState.overlayProxy?.overlayMgr?.overlays) || task?.overlays || [];
            const overlay = overlays.find(item => item.id === clip._overlayId);
            if (!overlay) return false;
            const ranges = Array.isArray(overlay.display_ranges) && overlay.display_ranges.length
                ? overlay.display_ranges.map(range => ({ ...range }))
                : [{ start: Number(overlay.start) || 0, end: Number(overlay.end) || 5 }];
            const rangeIndex = Math.max(0, Math.min(ranges.length - 1, Number(clip._overlayRangeIndex) || 0));
            const range = ranges[rangeIndex];
            if (timeSec <= range.start + 0.05 || timeSec >= range.end - 0.05) return true;
            ranges.splice(rangeIndex, 1, { start: range.start, end: timeSec }, { start: timeSec, end: range.end });
            overlay.display_ranges = ranges;
            overlay.start = ranges[0].start;
            overlay.end = ranges[ranges.length - 1].end;
            _updateTimelineForTask(task);
            if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
            if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
            return true;
        };
        _reelsState.timelineEditor.onClipDelete = (trackIdx, clipIdx, clip) => {
            if (clip?._timelineRole !== 'overlay') return false;
            const task = _getSelectedTask();
            const overlays = (_reelsState.overlayProxy?.overlayMgr?.overlays) || task?.overlays || [];
            const overlay = overlays.find(item => item.id === clip._overlayId);
            if (!overlay) return false;
            if (Array.isArray(overlay.display_ranges) && overlay.display_ranges.length > 1) {
                overlay.display_ranges.splice(Math.max(0, Number(clip._overlayRangeIndex) || 0), 1);
                overlay.start = overlay.display_ranges[0].start;
                overlay.end = overlay.display_ranges[overlay.display_ranges.length - 1].end;
            } else {
                overlay.disabled = true;
            }
            _updateTimelineForTask(task);
            if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
            if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
            return true;
        };

        // 双击字幕编辑后的回写
        _reelsState.timelineEditor.onSubtitleEdit = (trackIdx, clipIdx, newText, oldText, newRanges, styleOverride) => {
            const task = _getSelectedTask();
            if (!task || !task.segments) return;
            // 通过 _segIdx（如有）或 clipIdx 定位到 segment
            const track = _reelsState.timelineEditor._tracks[trackIdx];
            const clip = track && track.clips[clipIdx];
            const segIdx = (clip && clip._segIdx != null) ? clip._segIdx : clipIdx;
            if (segIdx >= 0 && segIdx < task.segments.length) {
                const seg = task.segments[segIdx];
                // 文字、富文本样式或逐字范围一旦由用户改过，就以 Reels 当前稿为准。
                task._manualSubtitleEdits = true;
                syncEditedSubtitleSegment(seg, newText);
                // 保存富文本样式范围
                if (newRanges && newRanges.length > 0) {
                    seg.styled_ranges = newRanges;
                    if (clip) clip.styled_ranges = newRanges;
                } else {
                    delete seg.styled_ranges;
                    if (clip) delete clip.styled_ranges;
                }
                if (styleOverride && Object.keys(styleOverride).length > 0) {
                    seg.style_override = styleOverride;
                    if (clip) clip.style_override = styleOverride;
                } else {
                    delete seg.style_override;
                    if (clip) delete clip.style_override;
                }
                
                console.log(`[Timeline] Segment #${segIdx} text/style updated: "${oldText}" → "${newText}"`, newRanges, styleOverride);
                // 刷新预览
                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
            }
        };
        // 加载默认空轨道
        _reelsState.timelineEditor.setTracks([
            { type: 'video', name: '视频', clips: [], locked: false, visible: true, domain: 'visual' },
            { type: 'subs', name: '字幕', clips: [], locked: false, visible: true, domain: 'visual' },
            { type: 'text', name: '文本覆层', clips: [], locked: false, visible: true, domain: 'visual' },
            { type: 'image', name: '图片覆层', clips: [], locked: false, visible: true, domain: 'visual' },
            { type: 'audio', name: '音频', clips: [], locked: false, visible: true, domain: 'audio' },
        ]);
    }

    // 覆层面板
    const ovPanelRoot = document.getElementById('reels-overlay-panel-root');
    if (ovPanelRoot && typeof ReelsOverlayPanel !== 'undefined') {
        // 创建轻量画布代理，让覆层面板可以管理覆层
        if (!_reelsState.overlayProxy) {
            const ReelsOverlayMod = window.ReelsOverlay;
            const mgr = ReelsOverlayMod ? new ReelsOverlayMod.OverlayManager() : { overlays: [], addOverlay(o) { this.overlays.push(o); return o; }, removeOverlay(id) { this.overlays = this.overlays.filter(o => o.id !== id); }, getOverlay(id) { return this.overlays.find(o => o.id === id) || null; } };
            _reelsState.overlayProxy = {
                overlayMgr: mgr,
                // 新增/删除必须立即写回当前任务。此前只改了临时预览管理器，
                // 任意一次任务/预览刷新都会从 task.overlays 重载旧数据，表现为
                // 文字覆层和媒体覆层“只能保留一个”。
                addOverlay(ov) {
                    const added = mgr.addOverlay(ov);
                    _syncCurrentOverlayEditorToSelectedTask();
                    return added;
                },
                removeOverlay(id) {
                    mgr.removeOverlay(id);
                    _syncCurrentOverlayEditorToSelectedTask();
                },
                // 覆层面板、左侧时间线与预览/导出必须共享同一个栈。
                // 普通覆层保存在 overlayMgr，插入素材是独立轨；这里只替换
                // 普通覆层所在的位置，保留插入素材在合成栈中的相对位置。
                getOrderedOverlays() {
                    const task = _getSelectedTask();
                    const overlays = mgr.overlays || [];
                    if (!task || !window.ReelsRenderPlan?.getCompositedOverlays) return overlays;
                    const rank = new Map(window.ReelsRenderPlan.getCompositedOverlays(task, { forExport: false })
                        .map((overlay, index) => [String(overlay.id), index]));
                    return overlays.slice().sort((a, b) => (rank.get(String(a.id)) ?? 0) - (rank.get(String(b.id)) ?? 0));
                },
                setOverlayOrder(overlayIds) {
                    const task = _getSelectedTask();
                    if (!task) return;
                    const sourceIds = new Set((mgr.overlays || []).map(overlay => String(overlay.id)));
                    const orderedIds = (overlayIds || []).map(String).filter(id => sourceIds.has(id));
                    if (!orderedIds.length) return;
                    const current = window.ReelsRenderPlan?.getCompositedOverlays?.(task, { forExport: false }) || [];
                    const saved = Array.isArray(task.visualOverlayOrder) ? task.visualOverlayOrder : [];
                    const stack = saved.length ? saved : current.map(overlay => overlay._compositeOrderKey);
                    let cursor = 0;
                    const next = stack.map(key => String(key).startsWith('overlay:')
                        ? `overlay:${orderedIds[cursor++] || String(key).slice('overlay:'.length)}`
                        : key);
                    while (cursor < orderedIds.length) next.push(`overlay:${orderedIds[cursor++]}`);
                    task.visualOverlayOrder = [...new Set(next)];
                    _syncCurrentOverlayEditorToSelectedTask();
                    _updateTimelineForTask(task);
                    reelsUpdatePreview();
                    if (typeof window.ReelsPreviewV2?.render === 'function') window.ReelsPreviewV2.render();
                },
                getSelected() { return null; },
                getTaskGroupTasks() {
                    if (typeof _getCurrentReelsGroupTasks === 'function' && _reelsState.selectedIdx >= 0) {
                        const group = _getCurrentReelsGroupTasks();
                        if (Array.isArray(group) && group.length > 0) return group;
                    }
                    const tasks = Array.isArray(_reelsState.tasks) ? _reelsState.tasks : [];
                    const selected = _getSelectedTask() || tasks[0] || null;
                    if (!selected) return tasks;
                    if (selected._folderQueueId) {
                        return tasks.filter(task => task && task._folderQueueId === selected._folderQueueId);
                    }
                    if (selected._batchTabId) {
                        return tasks.filter(task => task && task._batchTabId === selected._batchTabId);
                    }
                    const unpartitioned = tasks.filter(task => task && !task._folderQueueId && !task._batchTabId);
                    return unpartitioned.length > 0 ? unpartitioned : tasks;
                },
                render() { /* rAF loop handles rendering */ },
                getOverlayAboveSubtitle() {
                    const task = _getSelectedTask();
                    return task ? task.overlayAboveSubtitle !== false : true;
                },
                setOverlayAboveSubtitle(value) {
                    const task = _getSelectedTask();
                    if (!task) return;
                    task.overlayAboveSubtitle = value !== false;
                    // 预览、导出和时间线必须同用这个层级开关。以前这里只重绘
                    // 预览，时间线仍沿用切换前的轨道顺序，看起来像开关失效。
                    _updateTimelineForTask(task);
                    reelsUpdatePreview();
                    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
                },
                onOverlayChange() {
                    _syncCurrentOverlayEditorToSelectedTask();
                    reelsUpdatePreview();
                    if (window.ReelsPreviewV2?.isOpen?.() && typeof window.ReelsPreviewV2?.requestRender === 'function') {
                        window.ReelsPreviewV2.requestRender();
                    } else if (typeof window.ReelsPreviewV2?.render === 'function') {
                        window.ReelsPreviewV2.render();
                    }
                },
                // 回调占位
                onSelect: null,
                onDeselect: null,
            };
        }
        _reelsState.overlayPanel = new ReelsOverlayPanel(ovPanelRoot, _reelsState.overlayProxy);
    }

    reelsUpdatePreview();
    _bindReelsHotkeys();

    // ═══ 覆层预览交互 ═══
    _initOverlayCanvasInteraction();

    // ═══ 预览窗口缩放/平移初始化 ═══
    _initPreviewZoomPan();
    _initReelsExportDefaults();
    _initReelsIntroInput();
    _reelsUpdateLastOutputUI('');
    _reelsUpdateExportProgressUI(0, 0);
    _reelsUpdateLastErrorUI('');
    _initReelsCrashDiagnostics();

    // ═══ 面板拖拽调整宽度 ═══
    _initReelsColumnResize();

    // ═══ Windows Electron: 阻止 Inspector 面板的 mousedown 冒泡到视口 ═══
    // 防止预览视口的平移 handler 在 Windows 上抢夺输入焦点
    const inspectorCol = document.getElementById('reels-col-subtitle');
    if (inspectorCol) {
        inspectorCol.addEventListener('mousedown', (e) => {
            // 仅对面板内的可交互元素阻止冒泡（不拦截标题栏等非输入区域）
            const tag = e.target.tagName;
            if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' ||
                e.target.isContentEditable || e.target.closest('.rop-textarea, .rop-input, .rop-select, .rop-range, .rop-color')) {
                e.stopPropagation();
            }
        });
    }

    // ═══ 内容视频位置控制器 ═══
    _initCvPosControl();
}

// ── 内容视频位置可视化控制器 ──
function _initCvPosControl() {
    const panel = document.getElementById('reels-cv-pos-control');
    if (!panel) return;

    const xVal = document.getElementById('reels-cv-pos-x-val');
    const yVal = document.getElementById('reels-cv-pos-y-val');
    const scaleVal = document.getElementById('reels-cv-pos-scale-val');
    const stepSel = document.getElementById('reels-cv-pos-step');

    // 阻止面板内所有鼠标事件冒泡到预览视口（防止触发画布平移）
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('wheel', (e) => e.stopPropagation());

    // 获取当前选中任务
    function _getTask() {
        return _getSelectedTask ? _getSelectedTask() : (_selectedTask || null);
    }

    // 更新显示值
    function _updateDisplay() {
        const task = _getTask();
        if (!task) return;
        if (xVal) xVal.value = task.contentVideoX || 'center';
        if (yVal) yVal.value = task.contentVideoY || 'center';
        if (scaleVal) scaleVal.value = task.contentVideoScale || 100;
    }

    // X/Y 输入框直接编辑 (回车确认)
    function _onPosInput(axis, el) {
        const task = _getTask();
        if (!task) return;
        const val = el.value.trim() || 'center';
        if (axis === 'x') task.contentVideoX = val;
        else task.contentVideoY = val;
        _syncToTableInputs(task);
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    }
    if (xVal) xVal.addEventListener('change', () => _onPosInput('x', xVal));
    if (yVal) yVal.addEventListener('change', () => _onPosInput('y', yVal));

    // 缩放输入框直接编辑
    if (scaleVal) scaleVal.addEventListener('change', () => {
        const task = _getTask();
        if (!task) return;
        let v = parseInt(scaleVal.value) || 100;
        if (v < 1) v = 1;
        if (v > 1000) v = 1000;
        task.contentVideoScale = v;
        scaleVal.value = v;
        _syncToTableInputs(task);
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    });

    // ── 拖拽调整数值 (Scrub Drag) ──
    // 鼠标按住输入框后左右拖动 → 增减数值，类似 AE / Blender
    function _initScrubDrag(el, axis) {
        let _dragging = false;
        let _startX = 0;
        let _startVal = 0;
        let _moved = false;

        el.addEventListener('mousedown', (e) => {
            // 阻止冒泡到预览视口的拖拽/平移处理器
            e.stopPropagation();
            // 如果输入框正在编辑模式（有选中文本），不启动拖拽
            if (document.activeElement === el && el.selectionStart !== el.selectionEnd) return;

            _dragging = true;
            _moved = false;
            _startX = e.clientX;
            const task = _getTask();
            if (!task) return;
            const raw = axis === 'x' ? task.contentVideoX : task.contentVideoY;
            _startVal = (raw && raw !== 'center') ? (parseFloat(raw) || 0) : 0;

            // 防止拖拽时选中文本
            e.preventDefault();
            el.blur();
            document.body.style.cursor = 'ew-resize';
            el.style.borderColor = 'rgba(100,160,255,0.6)';
            el.style.background = 'rgba(100,160,255,0.15)';

            const onMove = (me) => {
                if (!_dragging) return;
                const dx = me.clientX - _startX;
                if (Math.abs(dx) > 2) _moved = true;
                if (!_moved) return;

                // 灵敏度：每像素移动 = step 值的比例
                const step = parseInt(stepSel?.value || '50');
                const sensitivity = step / 20; // 移动20px = 1个step
                const newVal = Math.round(_startVal + dx * sensitivity);

                const task = _getTask();
                if (!task) return;
                if (axis === 'x') task.contentVideoX = newVal === 0 ? 'center' : String(newVal);
                else task.contentVideoY = newVal === 0 ? 'center' : String(newVal);

                _updateDisplay();
                _syncToTableInputs(task);
                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
            };

            const onUp = () => {
                _dragging = false;
                document.body.style.cursor = '';
                el.style.borderColor = '#333';
                el.style.background = '#1a1a2e';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);

                // 如果没有拖拽（纯点击），聚焦让用户直接输入
                if (!_moved) {
                    el.style.cursor = 'text';
                    el.focus();
                    el.select();
                    // 失焦后恢复拖拽游标
                    el.addEventListener('blur', () => { el.style.cursor = 'ew-resize'; }, { once: true });
                }
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    if (xVal) _initScrubDrag(xVal, 'x');
    if (yVal) _initScrubDrag(yVal, 'y');

    // ── 缩放拖拽调整 (Scrub Drag for Scale) ──
    if (scaleVal) {
        let _sDragging = false, _sStartX = 0, _sStartVal = 100, _sMoved = false;
        scaleVal.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (document.activeElement === scaleVal && scaleVal.selectionStart !== scaleVal.selectionEnd) return;
            _sDragging = true; _sMoved = false; _sStartX = e.clientX;
            const task = _getTask();
            _sStartVal = task ? (task.contentVideoScale || 100) : 100;
            e.preventDefault(); scaleVal.blur();
            document.body.style.cursor = 'ew-resize';
            scaleVal.style.borderColor = 'rgba(100,160,255,0.6)';
            scaleVal.style.background = 'rgba(100,160,255,0.15)';

            const onMove = (me) => {
                if (!_sDragging) return;
                const dx = me.clientX - _sStartX;
                if (Math.abs(dx) > 2) _sMoved = true;
                if (!_sMoved) return;
                // 灵敏度: 拖拽20px = 变化10%
                const newVal = Math.max(1, Math.min(1000, Math.round(_sStartVal + dx * 0.5)));
                const task = _getTask();
                if (!task) return;
                task.contentVideoScale = newVal;
                scaleVal.value = newVal;
                _syncToTableInputs(task);
                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
            };
            const onUp = () => {
                _sDragging = false;
                document.body.style.cursor = '';
                scaleVal.style.borderColor = '#333'; scaleVal.style.background = '#1a1a2e';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (!_sMoved) {
                    scaleVal.style.cursor = 'text'; scaleVal.focus(); scaleVal.select();
                    scaleVal.addEventListener('blur', () => { scaleVal.style.cursor = 'ew-resize'; }, { once: true });
                }
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    // 缩放重置按钮
    const scaleResetBtn = document.getElementById('reels-cv-scale-reset');
    if (scaleResetBtn) scaleResetBtn.addEventListener('click', () => {
        const task = _getTask();
        if (!task) return;
        task.contentVideoScale = 100;
        _updateDisplay();
        _syncToTableInputs(task);
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    });

    // 将修改同步回批量表格的输入框和侧边栏
    function _syncToTableInputs(task) {
        if (!task || !window._reelsState) return;
        const idx = window._reelsState.tasks ? window._reelsState.tasks.indexOf(task) : -1;
        if (idx < 0) return;
        const xInput = document.querySelector(`.rbt-cvpos-x[data-idx="${idx}"]`);
        const yInput = document.querySelector(`.rbt-cvpos-y[data-idx="${idx}"]`);
        if (xInput) xInput.value = task.contentVideoX || 'center';
        if (yInput) yInput.value = task.contentVideoY || 'center';

        const scaleVal = task.contentVideoScale || 100;
        const scaleSlider = document.querySelector(`.rbt-cvscale-slider[data-idx="${idx}"]`);
        const scaleInput = document.querySelector(`.rbt-cvscale-input[data-idx="${idx}"]`);
        const scaleDisplay = document.querySelector(`.rbt-col-cvscale[data-idx="${idx}"] .rbt-scale-display`) || (document.querySelectorAll(`.rbt-col-cvscale`)[idx] ? document.querySelectorAll(`.rbt-col-cvscale`)[idx].querySelector('.rbt-scale-display') : null);
        if (scaleSlider) scaleSlider.value = scaleVal;
        if (scaleInput) scaleInput.value = scaleVal;
        if (scaleDisplay) scaleDisplay.textContent = scaleVal + '%';

        if (window.reelsSyncBackgroundTabUI) {
            window.reelsSyncBackgroundTabUI(task);
        }
        if (typeof window._syncCvPosControlToQueueIfEnabled === 'function') {
            window._syncCvPosControlToQueueIfEnabled(task);
        }
    }

    // 移动位置
    function _nudge(dir) {
        const task = _getTask();
        if (!task || !task.contentVideoPath) return;
        const step = parseInt(stepSel?.value || '50');

        // 解析当前像素值 (center 视为 0)
        let cx = 0, cy = 0;
        if (task.contentVideoX && task.contentVideoX !== 'center') {
            cx = parseFloat(task.contentVideoX) || 0;
        }
        if (task.contentVideoY && task.contentVideoY !== 'center') {
            cy = parseFloat(task.contentVideoY) || 0;
        }

        switch (dir) {
            case 'up':    cy -= step; break;
            case 'down':  cy += step; break;
            case 'left':  cx -= step; break;
            case 'right': cx += step; break;
        }

        task.contentVideoX = cx === 0 ? 'center' : String(cx);
        task.contentVideoY = cy === 0 ? 'center' : String(cy);
        _updateDisplay();
        _syncToTableInputs(task);
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    }

    // 重置为居中
    function _resetPos() {
        const task = _getTask();
        if (!task) return;
        task.contentVideoX = 'center';
        task.contentVideoY = 'center';
        _updateDisplay();
        _syncToTableInputs(task);
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    }

    // 绑定方向按钮
    panel.querySelectorAll('.reels-cv-dir-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            _nudge(btn.dataset.dir);
        });
        // 长按连续移动
        let _holdTimer = null;
        btn.addEventListener('mousedown', () => {
            _holdTimer = setInterval(() => _nudge(btn.dataset.dir), 120);
        });
        btn.addEventListener('mouseup', () => { clearInterval(_holdTimer); _holdTimer = null; });
        btn.addEventListener('mouseleave', () => { clearInterval(_holdTimer); _holdTimer = null; });
    });

    // 居中按钮
    const centerBtn = document.getElementById('reels-cv-pos-center-btn');
    if (centerBtn) centerBtn.addEventListener('click', _resetPos);

    // 重置按钮
    const resetBtn = document.getElementById('reels-cv-pos-reset');
    if (resetBtn) resetBtn.addEventListener('click', _resetPos);

    // 键盘方向键支持 (当控制器面板有焦点时)
    panel.addEventListener('keydown', (e) => {
        const keyMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
        if (keyMap[e.key]) {
            e.preventDefault();
            e.stopPropagation();
            _nudge(keyMap[e.key]);
        }
    });
    panel.tabIndex = 0; // 使其可聚焦以接收键盘事件

    // 控制器显示/隐藏: 按钮仅在有内容视频时显示，面板由用户手动开关
    const toggleBtn = document.getElementById('reels-cv-pos-toggle');
    setInterval(() => {
        const task = _getTask();
        const hasCV = task && task.contentVideoPath;
        // 仅控制 toggle 按钮的可见性
        if (toggleBtn) toggleBtn.style.display = hasCV ? '' : 'none';
        // 没有内容视频时自动隐藏面板
        if (!hasCV && panel.style.display !== 'none') {
            panel.style.display = 'none';
            if (toggleBtn) { toggleBtn.style.background = 'rgba(100,160,255,0.1)'; toggleBtn.style.color = '#8af'; }
        }
        // 面板打开时更新值
        if (hasCV && panel.style.display !== 'none') _updateDisplay();
    }, 500);
}

function _initReelsColumnResize() {
    const handles = document.querySelectorAll('.reels-resize-handle');
    if (!handles.length) return;

    // Restore saved widths
    const saved = localStorage.getItem('reels-col-widths');
    if (saved) {
        try {
            const widths = JSON.parse(saved);
            for (const [id, w] of Object.entries(widths)) {
                const el = document.getElementById(id);
                if (el && el.id !== 'reels-col-preview') {
                    el.style.width = w + 'px';
                    el.style.flex = 'none';
                }
            }
        } catch (e) { }
    }

    handles.forEach(handle => {
        handle.addEventListener('pointerdown', (e) => {
            // 仅响鼠标左键/主键
            if (e.button !== 0) return;
            e.preventDefault();

            // 使用 Pointer Capture 锁定事件
            try {
                handle.setPointerCapture(e.pointerId);
            } catch (err) {
                console.warn('[Resize] Failed to setPointerCapture:', err);
            }

            const leftId = handle.dataset.left;
            const rightId = handle.dataset.right;
            const leftEl = document.getElementById(leftId);
            const rightEl = document.getElementById(rightId);
            if (!leftEl || !rightEl) return;

            handle.classList.add('active');
            const startX = e.clientX;
            const leftW0 = leftEl.getBoundingClientRect().width;
            const rightW0 = rightEl.getBoundingClientRect().width;
            const leftMin = parseInt(getComputedStyle(leftEl).minWidth) || 100;
            const rightMin = parseInt(getComputedStyle(rightEl).minWidth) || 100;

            let _cleanedUp = false;

            const onMove = (ev) => {
                // 兜底：如果检测到没有按键被按下，说明早已松手，主动清理状态
                if (ev.buttons === 0) {
                    onUp();
                    return;
                }

                const dx = ev.clientX - startX;
                const newLeft = Math.max(leftMin, leftW0 + dx);
                const newRight = Math.max(rightMin, rightW0 - dx);
                // Only apply if both panels stay above minimum
                if (newLeft >= leftMin && newRight >= rightMin) {
                    leftEl.style.width = newLeft + 'px';
                    leftEl.style.flex = 'none';
                    // For the preview (flex:1) column, set flex instead
                    if (rightId === 'reels-col-preview') {
                        rightEl.style.flex = '1';
                    } else {
                        rightEl.style.width = newRight + 'px';
                        rightEl.style.flex = 'none';
                    }
                    if (leftId === 'reels-col-preview') {
                        leftEl.style.flex = '1';
                    }
                }
            };

            const onUp = () => {
                if (_cleanedUp) return;
                _cleanedUp = true;
                handle.classList.remove('active');

                // 释放 Pointer Capture
                try {
                    if (handle.hasPointerCapture(e.pointerId)) {
                        handle.releasePointerCapture(e.pointerId);
                    }
                } catch (err) {}

                // 注销 Pointer 事件监听
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
                handle.removeEventListener('lostpointercapture', onUp);
                window.removeEventListener('blur', onUp);
                document.removeEventListener('visibilitychange', onUp);

                // Save column widths
                const cols = {};
                ['reels-col-tasks', 'reels-col-subtitle'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) cols[id] = Math.round(el.getBoundingClientRect().width);
                });
                localStorage.setItem('reels-col-widths', JSON.stringify(cols));
            };

            // 全套 Pointer 监听注册到 handle 自身
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
            handle.addEventListener('lostpointercapture', onUp);
            
            // 安全网：失焦/隐藏时强制清理
            window.addEventListener('blur', onUp);
            document.addEventListener('visibilitychange', onUp);
        });
    });
}

async function _getSystemDownloadsPath() {
    // 优先使用设置页面自定义的默认输出目录
    const custom = localStorage.getItem('vk_default_output_dir');
    if (custom) return custom;
    try {
        if (window.electronAPI && typeof window.electronAPI.getDownloadsPath === 'function') {
            const p = await window.electronAPI.getDownloadsPath();
            if (p) return p;
        }
    } catch (e) { }
    return '~/Downloads';
}

async function _initReelsExportDefaults() {
    const outputEl = document.getElementById('reels-output-dir');
    const preferredDir = _readPreferredReelsOutputDir();
    if (outputEl && preferredDir) outputEl.value = preferredDir;
    if (outputEl && !outputEl.value) {
        const defaultDir = await _getSystemDownloadsPath();
        if (!outputEl.value) outputEl.value = _readPreferredReelsOutputDir() || defaultDir;
    }
    outputEl?.addEventListener('change', () => _rememberReelsOutputDir(outputEl.value));
    
    // Initialize export naming mode dropdown (outer)
    const namingModeOuter = document.getElementById('reels-export-naming-mode-outer');
    const namingConfigBtnOuter = document.getElementById('reels-export-naming-config-btn');
    const updateGearVisibility = (val) => {
        if (namingConfigBtnOuter) {
            namingConfigBtnOuter.style.display = (val === 'index' || val === 'date-auto') ? 'inline-block' : 'none';
        }
        const namingConfigBtnInner = document.getElementById('reels-naming-config-btn');
        if (namingConfigBtnInner) {
            namingConfigBtnInner.style.display = (val === 'index' || val === 'date-auto') ? 'inline-block' : 'none';
        }
    };

    if (namingModeOuter) {
        const storedVal = localStorage.getItem('reels_naming_mode') || 'text';
        namingModeOuter.value = storedVal;
        updateGearVisibility(storedVal);
        
        // Add change event listener for synchronization
        namingModeOuter.addEventListener('change', async (e) => {
            const val = e.target.value || 'text';
            localStorage.setItem('reels_naming_mode', val);
            const innerSelect = document.getElementById('reels-naming-mode');
            if (innerSelect) {
                innerSelect.value = val;
            }
            updateGearVisibility(val);
            if (val === 'index' || val === 'date-auto') {
                const ok = await showNamingSettingsDialog(val);
                if (!ok) {
                    localStorage.setItem('reels_naming_mode', 'text');
                    namingModeOuter.value = 'text';
                    if (innerSelect) innerSelect.value = 'text';
                    updateGearVisibility('text');
                }
            }
        });
    }

    if (namingConfigBtnOuter) {
        namingConfigBtnOuter.addEventListener('click', () => {
            const mode = localStorage.getItem('reels_naming_mode') || 'text';
            if (mode === 'index' || mode === 'date-auto') {
                showNamingSettingsDialog(mode);
            }
        });
    }
}

function _bindReelsHotkeys() {
    if (_reelsHotkeyBound) return;
    _reelsHotkeyBound = true;
    document.addEventListener('keydown', (e) => {
        if (e.code !== 'Space') return;
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
        const panel = document.getElementById('batch-reels-panel');
        if (!panel || !panel.classList.contains('active')) return;
        // V2 有自己的播放器和空格键处理，避免一次按键同时切换两套预览。
        if (window.ReelsPreviewV2?.isOpen?.()) return;
        e.preventDefault();
        reelsTogglePlay();
    });

    // Delete key removes selected overlay
    document.addEventListener('keydown', (e) => {
        if (e.code !== 'Delete' && e.code !== 'Backspace') return;
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
        if (!_isReelsPanelActive()) return;
        if (!_reelsState.overlaySelectedId) return;
        e.preventDefault();
        const proxy = _reelsState.overlayProxy;
        if (proxy) {
            proxy.removeOverlay(_reelsState.overlaySelectedId);
            _reelsState.overlaySelectedId = null;
            if (_reelsState.overlayPanel) {
                _reelsState.overlayPanel.deselectOverlay();
                _reelsState.overlayPanel._refreshList();
            }
        }
    });

    // 任务快速切换：避免在编辑表格/文案时误触方向键。
    document.addEventListener('keydown', (e) => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;
        if (!_isReelsPanelActive() || _reelsState.tasks.length === 0) return;

        const previous = e.code === 'ArrowUp' || e.code === 'ArrowLeft';
        const current = _reelsState.selectedIdx >= 0 ? _reelsState.selectedIdx : 0;
        const target = Math.max(0, Math.min(
            current + (previous ? -1 : 1),
            _reelsState.tasks.length - 1
        ));
        if (target === current) return;
        e.preventDefault();
        reelsSelectTask(target);
    });
}

// ═══════════════════════════════════════════════════════
// Overlay canvas interaction (drag, select, resize)
// ═══════════════════════════════════════════════════════

const _OV_HANDLE_SIZE = 12; // px in canvas coordinates

function _initOverlayCanvasInteraction() {
    const canvas = document.getElementById('reels-preview-canvas');
    if (!canvas) return;

    canvas.addEventListener('mousedown', _ovOnMouseDown);
    canvas.addEventListener('mousemove', _ovOnMouseMove);
    canvas.addEventListener('mouseup', _ovOnMouseUp);
    canvas.addEventListener('mouseleave', _ovOnMouseUp);
}

/** Convert client (screen) coordinates → canvas logical coordinates */
function _clientToCanvas(clientX, clientY) {
    const canvas = document.getElementById('reels-preview-canvas');
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    // The canvas is 1080x1920 logical, but displayed at rect.width x rect.height
    // Plus there's zoom/pan on the container
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
    };
}

/** Get the bounding box of an overlay in canvas coords */
function _ovGetBounds(ov) {
    const w = parseFloat(ov.w || 100);
    let x = parseFloat(ov.x || 0);
    let y, h;
    if (ov.type === 'textcard' && ov._renderedY != null) {
        y = ov._renderedY;
        h = ov._renderedH || 100;
    } else {
        y = parseFloat(ov.y || 0);
        h = parseFloat(ov.h || 100);
    }
    if (ov.anim_dest_enabled && ov.type !== 'scroll') {
        const start = parseFloat(ov.start || 0);
        const end = parseFloat(ov.end || 0);
        if (end > start) {
            const canvas = document.getElementById('reels-preview-canvas');
            const canvasW = (canvas && canvas.width) ? canvas.width : (_reelsState.targetWidth || 1080);
            const canvasH = (canvas && canvas.height) ? canvas.height : (_reelsState.targetHeight || 1920);

            const readAnimNumber = (value, fallback) => {
                const n = parseFloat(value);
                return Number.isFinite(n) ? n : fallback;
            };
            const fallbackStartX = (x + w / 2) - canvasW / 2;
            const fallbackStartY = (y + h / 2) - canvasH / 2;
            const startPointX = readAnimNumber(ov.anim_start_x, fallbackStartX);
            const startPointY = readAnimNumber(ov.anim_start_y, fallbackStartY);
            const endPointX = readAnimNumber(ov.anim_end_x, startPointX);
            const endPointY = readAnimNumber(ov.anim_end_y, startPointY);
            const fallbackDuration = (end >= 9999) ? 5.0 : (end - start);
            const explicitDuration = parseFloat(ov.anim_duration || 0);
            const speed = parseFloat(ov.anim_speed || 0);
            const distance = Math.hypot(endPointX - startPointX, endPointY - startPointY);
            const animDuration = (ov.anim_timing_mode === 'speed' && speed > 0)
                ? Math.max(0.001, distance / speed)
                : (explicitDuration > 0 ? explicitDuration : fallbackDuration);
            const now = (typeof _getPreviewCurrentTime === 'function') ? _getPreviewCurrentTime() : start;
            let p = Math.max(0, Math.min(1, (now - start) / Math.max(0.001, animDuration)));
            if (ov._previewAtEnd) p = 1;
            const easingName = ov.anim_easing || 'ease_in_out_quad';
            const easingFn = window.ReelsAnimEngine
                ? (window.ReelsAnimEngine.EASING_MAP[easingName] || window.ReelsAnimEngine.EASING_MAP.ease_in_out_quad)
                : null;
            const easedP = easingFn ? easingFn(p) : p;
            const pointX = startPointX + (endPointX - startPointX) * easedP;
            const pointY = startPointY + (endPointY - startPointY) * easedP;
            x = canvasW / 2 + pointX - w / 2;
            y = canvasH / 2 + pointY - h / 2;
        }
    }
    return { x, y, w, h };
}

/** Check if point hits one of the 8 resize handles. Returns handle name or null */
function _ovHitHandle(mx, my, bounds) {
    const hs = _OV_HANDLE_SIZE;
    const { x, y, w, h } = bounds;
    const handles = {
        'tl': { cx: x, cy: y },
        'tc': { cx: x + w / 2, cy: y },
        'tr': { cx: x + w, cy: y },
        'ml': { cx: x, cy: y + h / 2 },
        'mr': { cx: x + w, cy: y + h / 2 },
        'bl': { cx: x, cy: y + h },
        'bc': { cx: x + w / 2, cy: y + h },
        'br': { cx: x + w, cy: y + h },
    };
    for (const [name, pos] of Object.entries(handles)) {
        if (Math.abs(mx - pos.cx) <= hs && Math.abs(my - pos.cy) <= hs) {
            return name;
        }
    }
    return null;
}

function _ovOnMouseDown(e) {
    if (e.button !== 0) return; // left click only
    const proxy = _reelsState.overlayProxy;
    if (!proxy || !proxy.overlayMgr) return;

    const { x: mx, y: my } = _clientToCanvas(e.clientX, e.clientY);
    const overlays = proxy.overlayMgr.overlays || [];

    // 1. If already selected, check if clicking a resize handle
    if (_reelsState.overlaySelectedId) {
        const selOv = overlays.find(o => o.id === _reelsState.overlaySelectedId);
        if (selOv) {
            const bounds = _ovGetBounds(selOv);
            const handle = _ovHitHandle(mx, my, bounds);
            if (handle) {
                _reelsState.overlayDrag = {
                    ovId: selOv.id,
                    startX: mx, startY: my,
                    origX: selOv.x, origY: selOv.y, origW: selOv.w, origH: selOv.h || selOv._renderedH || 100,
                    handle,
                };
                e.stopPropagation();
                return;
            }
        }
    }

    // 2. Hit test all overlays (reverse z-order: topmost first)
    let hit = null;
    for (let i = overlays.length - 1; i >= 0; i--) {
        const ov = overlays[i];
        const bounds = _ovGetBounds(ov);
        if (mx >= bounds.x && mx <= bounds.x + bounds.w && my >= bounds.y && my <= bounds.y + bounds.h) {
            hit = ov;
            break;
        }
    }

    if (hit) {
        _reelsState.overlaySelectedId = hit.id;
        _reelsState.overlayDrag = {
            ovId: hit.id,
            startX: mx, startY: my,
            origX: hit.x, origY: hit.y, origW: hit.w, origH: hit.h || hit._renderedH || 100,
            handle: null, // move mode
        };
        // Sync with overlay panel
        if (_reelsState.overlayPanel) {
            _reelsState.overlayPanel.selectOverlay(hit);
        }
        e.stopPropagation();
    } else {
        // Deselect
        _reelsState.overlaySelectedId = null;
        _reelsState.overlayDrag = null;
        if (_reelsState.overlayPanel) {
            _reelsState.overlayPanel.deselectOverlay();
        }
    }
}

function _ovOnMouseMove(e) {
    const drag = _reelsState.overlayDrag;
    if (!drag) {
        // Update cursor based on hover
        _ovUpdateCursor(e);
        return;
    }
    if (e.buttons === 0) { // mouse released outside
        _reelsState.overlayDrag = null;
        return;
    }

    const proxy = _reelsState.overlayProxy;
    if (!proxy) return;
    const ov = (proxy.overlayMgr.overlays || []).find(o => o.id === drag.ovId);
    if (!ov) return;

    const { x: mx, y: my } = _clientToCanvas(e.clientX, e.clientY);
    const dx = mx - drag.startX;
    const dy = my - drag.startY;

    if (!drag.handle) {
        // Move
        ov.x = drag.origX + dx;
        ov.y = drag.origY + dy;
        if (ov.auto_center_v) ov.auto_center_v = false; // disable auto-center when manually moved
    } else {
        // Resize via handle
        _ovApplyResize(ov, drag, dx, dy);
    }

    // Sync panel
    if (_reelsState.overlayPanel && _reelsState.overlayPanel._selectedOv?.id === ov.id) {
        _reelsState.overlayPanel._syncFromOverlay(ov);
    }
}

function _ovOnMouseUp(e) {
    if (_reelsState.overlayDrag) {
        const proxy = _reelsState.overlayProxy;
        const ov = (proxy?.overlayMgr?.overlays || []).find(o => o.id === _reelsState.overlayDrag.ovId);
        _syncCurrentOverlayEditorToSelectedTask();
        if (ov && _reelsState.overlayPanel && typeof _reelsState.overlayPanel._syncOverlayStyleToScopeTasks === 'function') {
            _reelsState.overlayPanel._syncOverlayStyleToScopeTasks(ov);
        }
    }
    _reelsState.overlayDrag = null;
}

function _ovApplyResize(ov, drag, dx, dy) {
    const h = drag.handle;
    let x = drag.origX, y = drag.origY, w = drag.origW, ht = drag.origH;

    // Horizontal
    if (h.includes('l')) { x += dx; w -= dx; }
    if (h.includes('r')) { w += dx; }
    // Vertical
    if (h.includes('t')) { y += dy; ht -= dy; }
    if (h.includes('b')) { ht += dy; }

    // Enforce minimums
    if (w < 50) { w = 50; if (h.includes('l')) x = drag.origX + drag.origW - 50; }
    if (ht < 30) { ht = 30; if (h.includes('t')) y = drag.origY + drag.origH - 30; }

    ov.x = x;
    ov.y = y;
    ov.w = w;
    if (ov.type !== 'textcard' || !ov.auto_fit) {
        ov.h = ht;
    }
    if (ov.auto_center_v) ov.auto_center_v = false;
}

function _ovUpdateCursor(e) {
    const canvas = document.getElementById('reels-preview-canvas');
    if (!canvas || !_reelsState.overlaySelectedId) return;

    const proxy = _reelsState.overlayProxy;
    if (!proxy) return;
    const ov = (proxy.overlayMgr.overlays || []).find(o => o.id === _reelsState.overlaySelectedId);
    if (!ov) return;

    const { x: mx, y: my } = _clientToCanvas(e.clientX, e.clientY);
    const bounds = _ovGetBounds(ov);
    const handle = _ovHitHandle(mx, my, bounds);

    const cursors = {
        'tl': 'nw-resize', 'tr': 'ne-resize', 'bl': 'sw-resize', 'br': 'se-resize',
        'tc': 'n-resize', 'bc': 's-resize', 'ml': 'w-resize', 'mr': 'e-resize',
    };

    if (handle && cursors[handle]) {
        canvas.style.cursor = cursors[handle];
    } else if (mx >= bounds.x && mx <= bounds.x + bounds.w && my >= bounds.y && my <= bounds.y + bounds.h) {
        canvas.style.cursor = 'move';
    } else {
        canvas.style.cursor = '';
    }
}

/** Draw selection frame + 8 resize handles around the selected overlay */
function _drawOverlaySelectionUI(ctx, canvasW, canvasH) {
    if (!_reelsState.overlaySelectedId) return;
    const proxy = _reelsState.overlayProxy;
    if (!proxy) return;
    const ov = (proxy.overlayMgr.overlays || []).find(o => o.id === _reelsState.overlaySelectedId);
    if (!ov || ov.disabled) return;

    const bounds = _ovGetBounds(ov);
    const { x, y, w, h } = bounds;
    const hs = _OV_HANDLE_SIZE;

    ctx.save();
    // Dashed selection border
    ctx.strokeStyle = '#4c9eff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    // 8 resize handles
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#4c9eff';
    ctx.lineWidth = 2;
    const handles = [
        [x, y], [x + w / 2, y], [x + w, y],
        [x, y + h / 2], [x + w, y + h / 2],
        [x, y + h], [x + w / 2, y + h], [x + w, y + h],
    ];
    for (const [hx, hy] of handles) {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
    ctx.restore();
}

// ═══════════════════════════════════════════════════════
// Preview viewport zoom / pan
// ═══════════════════════════════════════════════════════

const _previewView = { scale: 1, panX: 0, panY: 0, dragging: false, lastX: 0, lastY: 0 };
let _reelsFitTimer = null;

function _isReelsPanelActive() {
    const panel = document.getElementById('batch-reels-panel');
    return !!(panel && panel.classList.contains('active'));
}

function _fitPreviewWhenReady(retry = 0) {
    const viewport = document.getElementById('reels-preview-viewport');
    const container = document.getElementById('reels-preview-container');
    if (!viewport || !container) return;
    const vpRect = viewport.getBoundingClientRect();
    if (vpRect.width > 20 && vpRect.height > 20 && container.offsetWidth > 20 && container.offsetHeight > 20) {
        reelsPreviewZoom('fit');
        return;
    }
    if (retry >= 12) return;
    if (_reelsFitTimer) clearTimeout(_reelsFitTimer);
    _reelsFitTimer = setTimeout(() => _fitPreviewWhenReady(retry + 1), 80);
}

function _initPreviewZoomPan() {
    const viewport = document.getElementById('reels-preview-viewport');
    if (!viewport) return;

    // 滚轮缩放
    viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.max(0.1, Math.min(5, _previewView.scale * factor));

        // 以鼠标位置为中心缩放
        const rect = viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const ratio = newScale / _previewView.scale;
        _previewView.panX = mx - ratio * (mx - _previewView.panX);
        _previewView.panY = my - ratio * (my - _previewView.panY);
        _previewView.scale = newScale;

        _applyPreviewTransform();
    }, { passive: false });

    // 拖拽平移 — 只在没有命中覆层时启用，或按住空格键强制平移
    viewport.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;

        // Check if the mouse is over the canvas and hits an overlay
        const canvas = document.getElementById('reels-preview-canvas');
        if (canvas && _reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
            const rect = canvas.getBoundingClientRect();
            if (e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom) {
                // Convert to canvas coords and check for overlay hit
                const scaleX = canvas.width / rect.width;
                const scaleY = canvas.height / rect.height;
                const mx = (e.clientX - rect.left) * scaleX;
                const my = (e.clientY - rect.top) * scaleY;
                const overlays = _reelsState.overlayProxy.overlayMgr.overlays || [];
                for (let i = overlays.length - 1; i >= 0; i--) {
                    const ov = overlays[i];
                    const bounds = _ovGetBounds(ov);
                    if (mx >= bounds.x && mx <= bounds.x + bounds.w &&
                        my >= bounds.y && my <= bounds.y + bounds.h) {
                        // Hit an overlay — let the overlay interaction handle this
                        return;
                    }
                    // Also check if hitting a resize handle of selected overlay
                    if (_reelsState.overlaySelectedId && ov.id === _reelsState.overlaySelectedId) {
                        const handle = _ovHitHandle(mx, my, bounds);
                        if (handle) return; // Let resize handle work
                    }
                }
            }
        }

        _previewView.dragging = true;
        _previewView.lastX = e.clientX;
        _previewView.lastY = e.clientY;
        viewport.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
        if (!_previewView.dragging) return;
        _previewView.panX += e.clientX - _previewView.lastX;
        _previewView.panY += e.clientY - _previewView.lastY;
        _previewView.lastX = e.clientX;
        _previewView.lastY = e.clientY;
        _applyPreviewTransform();
    });
    window.addEventListener('mouseup', () => {
        if (_previewView.dragging) {
            _previewView.dragging = false;
            const vp = document.getElementById('reels-preview-viewport');
            if (vp) vp.style.cursor = 'grab';
        }
    });

    // 初始适应（面板可能初始隐藏，需等待真实尺寸）
    setTimeout(() => _fitPreviewWhenReady(), 100);
}

function _applyPreviewTransform() {
    const el = document.getElementById('reels-preview-transform');
    if (!el) return;
    el.style.transform = `translate(${_previewView.panX}px, ${_previewView.panY}px) scale(${_previewView.scale})`;

    const label = document.getElementById('reels-preview-zoom-label');
    if (label) label.textContent = `${Math.round(_previewView.scale * 100)}%`;
}

function reelsPreviewZoom(action) {
    const viewport = document.getElementById('reels-preview-viewport');
    const container = document.getElementById('reels-preview-container');
    if (!viewport || !container) return;

    const vpRect = viewport.getBoundingClientRect();

    if (action === 'fit') {
        // 适应窗口：使 9:16 内容完整填入视口
        const containerW = container.offsetWidth;
        const containerH = container.offsetHeight;
        if (vpRect.width <= 0 || vpRect.height <= 0 || containerW <= 0 || containerH <= 0) return;
        const scaleW = vpRect.width / containerW;
        const scaleH = vpRect.height / containerH;
        _previewView.scale = Math.min(scaleW, scaleH) * 0.95; // 留 5% 边距
        // 居中
        _previewView.panX = (vpRect.width - containerW * _previewView.scale) / 2;
        _previewView.panY = (vpRect.height - containerH * _previewView.scale) / 2;
    } else if (action === 'reset') {
        _previewView.scale = 1;
        const containerW = container.offsetWidth;
        const containerH = container.offsetHeight;
        _previewView.panX = (vpRect.width - containerW) / 2;
        _previewView.panY = (vpRect.height - containerH) / 2;
    } else if (action === 'in') {
        const newScale = Math.min(5, _previewView.scale * 1.25);
        const cx = vpRect.width / 2;
        const cy = vpRect.height / 2;
        const ratio = newScale / _previewView.scale;
        _previewView.panX = cx - ratio * (cx - _previewView.panX);
        _previewView.panY = cy - ratio * (cy - _previewView.panY);
        _previewView.scale = newScale;
    } else if (action === 'out') {
        const newScale = Math.max(0.1, _previewView.scale * 0.8);
        const cx = vpRect.width / 2;
        const cy = vpRect.height / 2;
        const ratio = newScale / _previewView.scale;
        _previewView.panX = cx - ratio * (cx - _previewView.panX);
        _previewView.panY = cy - ratio * (cy - _previewView.panY);
        _previewView.scale = newScale;
    }

    _applyPreviewTransform();
}

async function _initFontManager() {
    if (typeof getFontManager !== 'function') {
        console.warn('[Reels] FontManager not loaded');
        return;
    }
    const fm = getFontManager();
    await fm.register();
    _refreshReelsFontSelects(fm, {
        'reels-font-family': _reelsState.renderer ? 'Arial' : undefined,
        'rop-font': 'Arial',
        'rop-title-font': 'Crimson Pro',
        'rop-body-font': 'Arial',
        'rop-footer-font': 'Arial',
        'rop-scroll-font': 'Arial',
    });
    try { await fm.loadGoogleFont('Crimson Pro'); } catch (_) { }
    reelsRefreshSubtitleWeightOptions();
    console.log(`[Reels] FontManager ready — ${fm.getAllFonts().length} fonts available`);
}

function _refreshReelsFontSelects(fm, values = {}) {
    if (!fm || typeof fm.refreshFontSelect !== 'function') return;
    const defaults = {
        'reels-font-family': 'Arial',
        'reels-fullpage-typewriter-title-font': 'Arial',
        'rop-font': 'Arial',
        'rop-title-font': 'Crimson Pro',
        'rop-body-font': 'Arial',
        'rop-footer-font': 'Arial',
        'rop-scroll-font': 'Arial',
        'rop-scroll-title-font': 'Arial',
    };
    const mergedValues = {};
    for (const [id, fallback] of Object.entries(defaults)) {
        mergedValues[id] = Object.prototype.hasOwnProperty.call(values, id) ? values[id] : fallback;
    }
    if (typeof fm.refreshAllFontSelects === 'function') {
        fm.refreshAllFontSelects(mergedValues);
    } else {
        for (const [id, val] of Object.entries(mergedValues)) {
            fm.refreshFontSelect(id, val);
        }
    }
}

function _initReelsFontPresetUI() {
    const select = document.getElementById('reels-font-preset');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">-- 字体预设 --</option>';
    for (const [key, preset] of Object.entries(REELS_FONT_PRESETS)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = preset.label;
        select.appendChild(opt);
    }
    if (current && REELS_FONT_PRESETS[current]) select.value = current;
}

function _initReelsAnimationPresetUI() {
    const select = document.getElementById('reels-animation-preset');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">-- 动画预设 --</option>';
    for (const [key, preset] of Object.entries(REELS_ANIMATION_PRESETS)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = preset.label;
        select.appendChild(opt);
    }
    if (current && REELS_ANIMATION_PRESETS[current]) select.value = current;
}

function reelsApplyAnimationPreset(silent = false) {
    const select = document.getElementById('reels-animation-preset');
    if (!select || !select.value) {
        if (!silent) alert('请先选择一个动画预设');
        return;
    }
    const preset = REELS_ANIMATION_PRESETS[select.value];
    if (!preset) return;

    const set = (id, val) => {
        const el = document.getElementById(id);
        if (!el || val === undefined || val === null) return;
        el.value = String(val);
    };
    const setChk = (id, val) => {
        const el = document.getElementById(id);
        if (!el || val === undefined || val === null) return;
        el.checked = !!val;
    };

    set('reels-anim-in', preset.anim_in_type);
    set('reels-anim-in-dur', preset.anim_in_duration);
    set('reels-anim-in-dur-range', preset.anim_in_duration);
    set('reels-anim-out', preset.anim_out_type);
    set('reels-anim-out-dur', preset.anim_out_duration);
    set('reels-anim-out-dur-range', preset.anim_out_duration);
    set('reels-float-amp', preset.floating_amplitude);
    set('reels-float-amp-range', preset.floating_amplitude);
    set('reels-float-period', preset.floating_period);
    set('reels-float-period-range', preset.floating_period);
    set('reels-bounce-height', preset.char_bounce_height);
    set('reels-bounce-height-range', preset.char_bounce_height);
    set('reels-metro-bpm', preset.metronome_bpm);
    set('reels-metro-bpm-range', preset.metronome_bpm);
    set('reels-jump-scale', preset.letter_jump_scale);
    set('reels-jump-scale-range', preset.letter_jump_scale);
    set('reels-flash-color', preset.flash_color);
    set('reels-glow-color', preset.holy_glow_color);
    set('reels-glow-radius', preset.holy_glow_radius);
    set('reels-glow-radius-range', preset.holy_glow_radius);
    set('reels-blur-max', preset.blur_sharp_max);
    set('reels-blur-max-range', preset.blur_sharp_max);
    set('reels-typewriter-reveal-type', preset.typewriter_reveal_type);
    if (preset.tw_unrevealed_opacity !== undefined) {
        const opacity = Number(preset.tw_unrevealed_opacity);
        const opacity255 = Math.round(Math.max(0, Math.min(255, opacity > 1 ? opacity : opacity * 255)));
        set('reels-typewriter-unread-opacity', opacity255);
        set('reels-typewriter-unread-opacity-range', opacity255);
    }
    // 逐词预设的专属参数也必须落到 UI；否则换过另一种动态字幕后，
    // 当前预设会悄悄沿用上一种的缩放/透明度。
    set('reels-word-pop-min', preset.word_pop_random_min_scale);
    set('reels-word-pop-min-range', preset.word_pop_random_min_scale);
    set('reels-word-pop-max', preset.word_pop_random_max_scale);
    set('reels-word-pop-max-range', preset.word_pop_random_max_scale);
    set('reels-word-pop-dur', preset.word_pop_random_duration);
    set('reels-word-pop-dur-range', preset.word_pop_random_duration);
    set('reels-word-pop-pulse-min', preset.word_pop_random_pulse_min_scale);
    set('reels-word-pop-pulse-min-range', preset.word_pop_random_pulse_min_scale);
    set('reels-word-pop-pulse-max', preset.word_pop_random_pulse_max_scale);
    set('reels-word-pop-pulse-max-range', preset.word_pop_random_pulse_max_scale);
    set('reels-word-pop-pulse-dur', preset.word_pop_random_pulse_duration);
    set('reels-word-pop-pulse-dur-range', preset.word_pop_random_pulse_duration);
    set('reels-word-pop-unread-opacity', preset.word_pop_random_unread_opacity);
    set('reels-word-pop-unread-opacity-range', preset.word_pop_random_unread_opacity);
    set('reels-word-pop-read-opacity', preset.word_pop_random_read_opacity);
    set('reels-word-pop-read-opacity-range', preset.word_pop_random_read_opacity);
    set('reels-metro-unread-opacity', preset.metro_unread_opacity);
    set('reels-metro-unread-opacity-range', preset.metro_unread_opacity);
    set('reels-char-anim-intensity', preset.char_anim_intensity);
    set('reels-char-anim-intensity-range', preset.char_anim_intensity);
    set('reels-char-anim-duration', preset.char_anim_duration);
    set('reels-char-anim-duration-range', preset.char_anim_duration);
    set('reels-char-anim-stagger', preset.char_anim_stagger);
    set('reels-char-anim-stagger-range', preset.char_anim_stagger);
    if (preset.karaoke_highlight !== undefined) {
        setChk('reels-karaoke-hl', preset.karaoke_highlight);
        setChk('reels-highlight-enabled', preset.karaoke_highlight);
    }

    _persistSubtitleStyleByScope(_readStyleFromUI());
    reelsRefreshAnimationParameterAvailability();
    reelsUpdatePreview();
}

function reelsApplyAnimationPresetQuick() {
    reelsApplyAnimationPreset(true);
}

// 动画参数全部保留在面板中，方便用户了解能力范围；当前动画用不到的
// 参数锁定并可点击说明，避免“改了但没有效果”的误会。
const REELS_ANIMATION_PARAM_GROUPS = [
    { types: ['floating'], label: '漂浮', ids: ['reels-float-amp', 'reels-float-amp-range', 'reels-float-period', 'reels-float-period-range'] },
    { types: ['typewriter'], label: '打字机', ids: ['reels-typewriter-reveal-type', 'reels-typewriter-unread-opacity', 'reels-typewriter-unread-opacity-range'] },
    { types: ['char_bounce'], label: '逐字弹跳', ids: ['reels-bounce-height', 'reels-bounce-height-range'] },
    { types: ['char_float_up', 'char_pop_elastic', 'char_wave', 'char_drop_bounce', 'char_squash_bounce', 'char_center_spread'], label: '逐字动画', ids: [
        'reels-char-anim-intensity', 'reels-char-anim-intensity-range',
        'reels-char-anim-duration', 'reels-char-anim-duration-range',
        'reels-char-anim-stagger', 'reels-char-anim-stagger-range'
    ] },
    { types: ['metronome'], label: '节奏逐词', ids: ['reels-metro-bpm', 'reels-metro-bpm-range', 'reels-metro-read-color', 'reels-metro-unread-color', 'reels-metro-unread-opacity', 'reels-metro-unread-opacity-range'] },
    { types: ['letter_jump'], label: '逐字放大', ids: ['reels-jump-scale', 'reels-jump-scale-range'] },
    { types: ['flash_highlight'], label: '闪光高亮', ids: ['reels-flash-color'] },
    { types: ['holy_glow'], label: '圣光字幕', ids: ['reels-glow-color', 'reels-glow-radius', 'reels-glow-radius-range'] },
    { types: ['blur_sharp'], label: '模糊到清晰', ids: ['reels-blur-max', 'reels-blur-max-range'] },
    { types: ['word_pop_random', 'word_pop_random_pulse'], label: '逐词弹出／回弹', ids: [
        'reels-word-pop-min', 'reels-word-pop-min-range', 'reels-word-pop-max', 'reels-word-pop-max-range',
        'reels-word-pop-dur', 'reels-word-pop-dur-range', 'reels-word-pop-unread-opacity',
        'reels-word-pop-unread-opacity-range', 'reels-word-pop-read-opacity', 'reels-word-pop-read-opacity-range',
        'reels-random-word-spacing', 'reels-random-word-spacing-range', 'reels-random-line-spacing',
        'reels-random-line-spacing-range', 'reels-random-spacing-seed', 'reels-only-show-active-word'
    ] },
];

function _showAnimationParamHint(label) {
    let toast = document.getElementById('reels-animation-param-hint');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'reels-animation-param-hint';
        toast.style.cssText = 'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:100000;padding:9px 14px;border-radius:7px;background:rgba(20,20,28,.96);border:1px solid rgba(255,255,255,.16);color:#fff;font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;';
        document.body.appendChild(toast);
    }
    toast.textContent = `此参数仅在“${label}”动画中可编辑。请先切换入场动画。`;
    toast.style.display = 'block';
    clearTimeout(_reelsState._animationParamHintTimer);
    _reelsState._animationParamHintTimer = setTimeout(() => { toast.style.display = 'none'; }, 2600);
}

function reelsRefreshAnimationParameterAvailability() {
    // 移除所有可能遗留的遮罩按钮
    document.querySelectorAll('.reels-anim-param-blocker').forEach(b => b.remove());

    const activeType = document.getElementById('reels-anim-in')?.value || 'none';
    
    // 智能动态切换：根据当前选择的入场动画展示对应专属参数卡片，隐藏其他无关卡片
    const boxes = document.querySelectorAll('.reels-anim-group-box');
    boxes.forEach(box => {
        const types = (box.getAttribute('data-anim-types') || '').split(',').map(s => s.trim()).filter(Boolean);
        const isMatch = types.includes(activeType);
        box.style.display = isMatch ? 'block' : 'none';
    });

    // 确保所有参数输入控件完全可用（非 disabled），且容器样式正常
    const container = document.getElementById('reels-anim-param-container');
    if (container) {
        container.querySelectorAll('input, select, button').forEach(el => {
            el.disabled = false;
        });
        container.querySelectorAll('div').forEach(el => {
            el.style.opacity = '';
            el.style.position = '';
        });
    }
}

function reelsRefreshSubtitleWeightOptions() {
    const familyEl = document.getElementById('reels-font-family');
    const weightEl = document.getElementById('reels-font-weight');
    if (!familyEl || !weightEl) return;

    const currentWeight = String(weightEl.value || '700');
    const fallback = [
        { value: '100', label: 'Thin' },
        { value: '200', label: 'ExtraLight' },
        { value: '300', label: 'Light' },
        { value: '400', label: 'Regular' },
        { value: '500', label: 'Medium' },
        { value: '600', label: 'SemiBold' },
        { value: '700', label: 'Bold' },
        { value: '800', label: 'ExtraBold' },
        { value: '900', label: 'Black' },
    ];
    let entries = fallback;

    if (typeof getFontManager === 'function') {
        const fm = getFontManager();
        if (fm && typeof fm.getFontWeightEntries === 'function') {
            const preferStyle = document.getElementById('reels-italic')?.checked ? 'italic' : 'normal';
            const list = fm.getFontWeightEntries(familyEl.value, preferStyle);
            if (Array.isArray(list) && list.length > 0) {
                entries = list.map(item => {
                    const value = String(item.value || '400');
                    const label = String(item.label || value);
                    return { value, label };
                });
            }
        } else if (fm && typeof fm.getFontWeightOptions === 'function') {
            const list = fm.getFontWeightOptions(familyEl.value);
            if (Array.isArray(list) && list.length > 0) {
                entries = list.map(v => ({ value: String(v), label: String(v) }));
            }
        }
    }

    const weights = entries.map(e => e.value);
    weightEl.innerHTML = entries.map(e => `<option value="${e.value}">${e.label}</option>`).join('');
    if (weights.includes(currentWeight)) {
        weightEl.value = currentWeight;
    } else if (weights.includes('700')) {
        weightEl.value = '700';
    } else {
        weightEl.value = weights[weights.length - 1] || '700';
    }
    reelsSyncWeightToBold();
}

async function reelsOnSubtitleFontFamilyChange() {
    const familyEl = document.getElementById('reels-font-family');
    if (!familyEl) return;
    if (typeof getFontManager === 'function') {
        try {
            const fm = getFontManager();
            await fm.loadGoogleFont(familyEl.value);
        } catch (_) { }
    }
    reelsRefreshSubtitleWeightOptions();
    reelsUpdatePreview();
}

function reelsSyncBoldToWeight() {
    const boldEl = document.getElementById('reels-bold');
    const weightEl = document.getElementById('reels-font-weight');
    if (!boldEl || !weightEl) return;
    const next = boldEl.checked ? '700' : '400';
    const opts = Array.from(weightEl.options || []).map(o => o.value);
    if (opts.includes(next)) {
        weightEl.value = next;
    } else if (boldEl.checked) {
        const high = opts.filter(v => parseInt(v, 10) >= 600);
        if (high.length > 0) weightEl.value = high[Math.min(1, high.length - 1)];
    } else {
        const low = opts.filter(v => parseInt(v, 10) < 600);
        if (low.length > 0) weightEl.value = low[Math.max(0, low.length - 2)];
    }
}

function reelsSyncWeightToBold() {
    const boldEl = document.getElementById('reels-bold');
    const weightEl = document.getElementById('reels-font-weight');
    if (!boldEl || !weightEl) return;
    const w = parseInt(weightEl.value || '700', 10);
    boldEl.checked = Number.isFinite(w) ? w >= 600 : true;
}

function reelsUploadFont() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ttf,.otf,.woff,.woff2';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const fm = getFontManager();
        const familyName = await fm.uploadFont(file);
        if (familyName) {
            _refreshReelsFontSelects(fm, {
                'reels-font-family': familyName,
                'rop-font': familyName,
                'rop-title-font': familyName,
                'rop-body-font': familyName,
                'rop-footer-font': familyName,
                'rop-scroll-font': familyName,
                'rop-scroll-title-font': familyName,
            });
            const select = document.getElementById('reels-font-family');
            if (select) select.value = familyName;
            reelsRefreshSubtitleWeightOptions();
            reelsUpdatePreview();
            console.log(`[Reels] Custom font uploaded: ${familyName}`);
        } else {
            alert('字体加载失败，请确认文件格式正确');
        }
    };
    input.click();
}

async function reelsApplyFontPreset(silent = false) {
    const select = document.getElementById('reels-font-preset');
    if (!select || !select.value) {
        if (!silent) alert('请先选择一个字体预设');
        return;
    }
    const preset = REELS_FONT_PRESETS[select.value];
    if (!preset) return;

    const set = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = String(val);
    };
    const setChk = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = !!val;
    };

    if (typeof getFontManager === 'function') {
        const fm = getFontManager();
        await fm.loadGoogleFont(preset.font_family);
        fm.refreshFontSelect('reels-font-family', preset.font_family);
    }

    set('reels-font-family', preset.font_family);
    set('reels-font-weight', preset.font_weight || (preset.bold ? 700 : 400));
    set('reels-fontsize', preset.fontsize);
    set('reels-fontsize-range', preset.fontsize);
    setChk('reels-bold', preset.bold);
    setChk('reels-italic', preset.italic);
    set('reels-letter-spacing', preset.letter_spacing);
    reelsRefreshSubtitleWeightOptions();
    reelsSyncWeightToBold();

    reelsUpdatePreview();
}

function reelsApplyFontPresetQuick() {
    return reelsApplyFontPreset(true);
}

function _cloneSubtitleStyle(style) {
    if (!style || typeof style !== 'object') return null;
    try {
        return JSON.parse(JSON.stringify(style));
    } catch (_) {
        return { ...style };
    }
}

function _isStyleApplyAllEnabled() {
    return _getSubtitleStyleScope() === 'all';
}

function _getSubtitleStyleScope() {
    const el = document.getElementById('reels-style-scope');
    return el ? (el.value || 'folder') : 'folder';
}

function _getCurrentReelsGroupTasks() {
    const task = _getSelectedTask();
    if (!task) return [];
    // folder 作用域必须优先按真实队列分组。恢复后所有队列都可能
    // 共享同一个“批量导入任务”标签 ID；先按 batchTabId 会把修改误应用到 108 条。
    if (task._folderQueueId) {
        return (_reelsState.tasks || []).filter(t => t._folderQueueId === task._folderQueueId);
    }
    if (task._batchTabId) {
        return (_reelsState.tasks || []).filter(t => t._batchTabId === task._batchTabId);
    }
    // 未分文件夹/标签的普通任务属于同一个主队列/默认分组（整批任务一同控制）
    const unpartitioned = (_reelsState.tasks || []).filter(t => !t._folderQueueId && !t._batchTabId);
    return unpartitioned.length > 0 ? unpartitioned : (_reelsState.tasks || [task]);
}

function _getNamedSubtitlePresetStyle(name) {
    if (!name || !window.ReelsStyleEngine) return null;
    const data = ReelsStyleEngine.loadSubtitlePresets();
    if (!data.presets || !(name in data.presets)) return null;
    return ReelsStyleEngine.applySubtitlePreset(name);
}

function _resolveSubtitleStyleForTask(task) {
    let style = _resolveSubtitleStyleForTaskBase(task);
    if(style?.fullpage_typewriter_split && style.fullpage_typewriter_auto_sequence===undefined)style={...style,fullpage_typewriter_auto_sequence:true,fullpage_typewriter_title_reveal:'char',fullpage_typewriter_title_delay:0,fullpage_typewriter_body_delay:0};
    if(task?.writingSplit)style={...style,...task.subtitleStyle};
    return getWritingVisualStyle(task?.writingTitle!==undefined && style.fullpage_typewriter_title_auto===false ? {...style, fullpage_typewriter_title_text:task.writingTitle} : style);
}
function _resolveSubtitleStyleForTaskBase(task) {
    const globalStyle = _reelsState.globalSubtitleStyle;
    // ── 最高优先级：批量表格中设置的字幕模板预设 ──
    if (task && task._subtitlePreset && window.ReelsStyleEngine) {
        const presetStyle = _getNamedSubtitlePresetStyle(task._subtitlePreset);
        if (presetStyle) return presetStyle;
        task._subtitlePreset = '';
    }
    // “全部任务”模式：若未指定独立预设，读取全局/UI样式
    if (_isStyleApplyAllEnabled()) {
        return _cloneSubtitleStyle(globalStyle) || _readStyleFromUI();
    }
    // ── 任务级独立字幕样式 ──
    if (task && task.subtitleStyle && typeof task.subtitleStyle === 'object' && Object.keys(task.subtitleStyle).length > 0) {
        return _cloneSubtitleStyle(task.subtitleStyle);
    }
    // 旧工程/旧队列模板把完整字幕样式保存在 task.style。
    // 恢复后不能因为没有新字段 subtitleStyle 就回退成默认样式。
    if (task && task.style && typeof task.style === 'object' && Object.keys(task.style).length > 0) {
        return _cloneSubtitleStyle(task.style);
    }
    return _cloneSubtitleStyle(globalStyle) || _readStyleFromUI();
}

function _persistSubtitleStyleByScope(style) {
    const safeStyle = _cloneSubtitleStyle(style || _readStyleFromUI());
    if (!safeStyle) return;
    const scope = _getSubtitleStyleScope();
    if (scope === 'all') {
        _reelsState.globalSubtitleStyle = safeStyle;
        for (const t of (_reelsState.tasks || [])) {
            t.subtitleStyle = _cloneSubtitleStyle(safeStyle);
        }
        return;
    }
    const task = _getSelectedTask();
    if (!task) return;
    if (scope === 'folder') {
        for (const queueTask of _getCurrentReelsGroupTasks()) {
            queueTask.subtitleStyle = _cloneSubtitleStyle(safeStyle);
        }
        return;
    }
    task.subtitleStyle = safeStyle;
}

function reelsOnStyleApplyScopeChange() {
    const nextScope = _getSubtitleStyleScope();
    const previousScope = _reelsState.lastSubtitleStyleScope || 'folder';
    // 用户的工作流是“先全部定样式，再逐条调位置”。离开全部模式时，旧代码
    // 会重新读出每条任务历史保存的完整样式，直接把刚设好的红字覆盖掉。
    // 现在把“全部”样式作为独立编辑的起点：每条任务先拿到一份副本，后续
    // 单独改位置只会改各自副本，不会改变颜色/字体等已定好的全局基准。
    if (previousScope === 'all' && nextScope !== 'all') {
        const baseStyle = _cloneSubtitleStyle(_reelsState.globalSubtitleStyle) || _cloneSubtitleStyle(_readStyleFromUI());
        const targets = nextScope === 'task'
            ? (_reelsState.tasks || [])
            : _getCurrentReelsGroupTasks();
        for (const target of targets) {
            target.subtitleStyle = _cloneSubtitleStyle(baseStyle);
            target._subtitlePreset = '';
        }
    }
    _reelsState.lastSubtitleStyleScope = nextScope;
    const style = _resolveSubtitleStyleForTask(_getSelectedTask());
    if (style) _writeStyleToUI(style);
    reelsUpdatePreview();
}

// ═══════════════════════════════════════════════════════
// Style: read all params from UI → style object
// ═══════════════════════════════════════════════════════

function _readStyleFromUI() {
    const get = (id) => document.getElementById(id);
    const val = (id) => {
        const el = get(id);
        if (!el) return '';
        if (el.dataset?.gradientValue) {
            return el.dataset.gradientValue;
        }
        if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
            return el.value;
        }
        return el.dataset.rawValue !== undefined ? el.dataset.rawValue : el.value;
    };
    const num = (id, def) => { const v = parseFloat(val(id)); return isNaN(v) ? def : v; };
    const chk = (id) => get(id) ? get(id).checked : false;

    // Update labels
    const swLabel = get('reels-stroke-width-label');
    if (swLabel) swLabel.textContent = val('reels-stroke-width');
    const sbLabel = get('reels-shadow-blur-label');
    if (sbLabel) sbLabel.textContent = val('reels-shadow-blur');
    const soxLabel = get('reels-shadow-offset-x-label');
    if (soxLabel) soxLabel.textContent = val('reels-shadow-offset-x');
    const soyLabel = get('reels-shadow-offset-y-label');
    if (soyLabel) soyLabel.textContent = val('reels-shadow-offset-y');
    const pxLabel = get('reels-pos-x-label');
    if (pxLabel) pxLabel.textContent = val('reels-pos-x') + '%';
    const pyLabel = get('reels-pos-y-label');
    if (pyLabel) pyLabel.textContent = val('reels-pos-y') + '%';
    const wwLabel = get('reels-wrap-width-label');
    if (wwLabel) wwLabel.textContent = val('reels-wrap-width') + '%';

    const baseStyle = {
        // Font
        mixed_layout: val('reels-mixed-layout') || 'none',
        font_family: val('reels-font-family') || 'Arial',
        font_weight: num('reels-font-weight', chk('reels-bold') ? 700 : 400),
        fontsize: num('reels-fontsize', 74),
        bold: num('reels-font-weight', chk('reels-bold') ? 700 : 400) >= 600,
        italic: chk('reels-italic'),
        uppercase: chk('reels-uppercase'),
        letter_spacing: num('reels-letter-spacing', 0),
        text_direction: val('reels-text-direction') || 'auto',

        // Colors
        color_text: val('reels-color-text') || '#FFFFFF',
        text_gradient_direction: get('reels-color-text')?.dataset?.gradientDirection || 'horizontal',
        text_gradient_scope: val('reels-text-gradient-scope') || 'line',
        highlight_enabled: get('reels-highlight-enabled')
            ? chk('reels-highlight-enabled')
            : (get('reels-karaoke-hl') ? chk('reels-karaoke-hl') : true),
        highlight_scale_enabled: get('reels-highlight-scale-enabled')
            ? chk('reels-highlight-scale-enabled')
            : chk('reels-anim-highlight-scale-enabled'),
        highlight_scale: num('reels-highlight-scale', 125),
        hide_until_spoken: get('reels-hide-until-spoken')
            ? chk('reels-hide-until-spoken')
            : chk('reels-anim-hide-until-spoken'),
        unread_opacity: num('reels-unread-opacity', 0),
        color_high: val('reels-color-high') || '#FFD700',
        high_gradient_direction: get('reels-color-high')?.dataset?.gradientDirection || 'horizontal',

        // Stroke
        use_stroke: chk('reels-use-stroke'),
        color_outline: val('reels-stroke-color') || '#3E2723',
        border_width: num('reels-stroke-width', 3),
        opacity_outline: 255,

        // Multi-layer stroke expand
        stroke_expand_enabled: chk('reels-stroke-expand'),
        stroke_expand_layers: num('reels-se-layers', 3),
        stroke_expand_step: num('reels-se-step', 4),
        stroke_expand_feather: num('reels-se-feather', 8),
        stroke_expand_colors: val('reels-se-colors') || '#FF0000,#00FF00,#0000FF',

        // Shadow
        shadow_blur: chk('reels-shadow') ? num('reels-shadow-blur', 4) : 0,
        shadow_offset_x: chk('reels-shadow') ? num('reels-shadow-offset-x', 0) : 0,
        shadow_offset_y: chk('reels-shadow') ? num('reels-shadow-offset-y', 2) : 0,
        color_shadow: val('reels-shadow-color') || '#000000',
        opacity_shadow: chk('reels-shadow') ? 150 : 0,

        // Box
        use_box: chk('reels-use-box') || chk('reels-box-wipe') || val('reels-anim-in') === 'box_wipe',
        box_adaptive_width: chk('reels-box-adaptive-width') || chk('reels-box-wipe') || val('reels-anim-in') === 'box_wipe',
        box_connected: (chk('reels-box-wipe') || val('reels-anim-in') === 'box_wipe')
            ? false
            : (get('reels-box-connected') ? chk('reels-box-connected') : true),
        box_wipe_enabled: chk('reels-box-wipe') || val('reels-anim-in') === 'box_wipe',
        box_concave_radius: num('reels-box-concave-radius', 10),
        box_snap_threshold: num('reels-box-snap-threshold', 18),
        box_brush_style: val('reels-box-brush-style') || 'rect',
        box_brush_color_mode: val('reels-box-brush-color-mode') || 'tint',
        box_custom_brush_data: val('reels-box-custom-brush-data') || '',
        box_brush_w: num('reels-box-brush-w', 0),
        box_brush_h: num('reels-box-brush-h', 0),
        box_brush_x: num('reels-box-brush-x', 0),
        box_brush_y: num('reels-box-brush-y', 0),
        box_brush_solid: num('reels-box-brush-solid', 100),
        color_bg: val('reels-box-color') || '#000000',
        opacity_bg: num('reels-box-opacity', 150),
        box_radius: num('reels-box-radius', 8),
        box_blur: num('reels-box-blur', 0),
        box_padding_x: num('reels-box-pad-x', 12),
        box_padding_y: num('reels-box-pad-y', 8),

        // Box gradient
        bg_gradient_enabled: chk('reels-bg-gradient'),
        bg_gradient_type: val('reels-bg-gradient-type') || 'linear_h',
        bg_gradient_colors: val('reels-bg-gradient-colors') || '#e0c3fc,#8ec5fc',
        bg_gradient_highlight: chk('reels-bg-gradient-hl'),

        // Box color transition
        box_transition_enabled: chk('reels-box-transition'),
        box_transition_color_to: val('reels-box-transition-color') || '#FF6600',

        // Underline controls are rendered by ReelsCanvasRenderer.  They were
        // present in the UI but omitted here, leaving the feature unreachable.
        use_underline: chk('reels-use-underline'),
        color_underline: val('reels-underline-color') || '#FFD700',

        // Dynamic box
        dynamic_box: chk('reels-dynamic-box'),
        dynamic_box_stroke: chk('reels-dynamic-box-stroke'),
        dynamic_box_stroke_width: num('reels-dynamic-box-stroke-width', 2),
        color_high_bg: val('reels-high-bg-color') || '#FFD700',
        opacity_high_bg: num('reels-high-bg-opacity', 200),
        dyn_box_anim: chk('reels-dyn-anim'),
        dyn_box_anim_overshoot: 1.3,
        dyn_box_anim_duration: 0.15,
        dynamic_radius: num('reels-dyn-radius', 6),
        high_padding: num('reels-high-padding', 4),
        high_offset_y: 0,

        // Synchronize karaoke_highlight with highlight_enabled so the inspector
        // checkbox (#reels-highlight-enabled) and menu toggle (#reels-karaoke-hl)
        // never contradict each other.
        karaoke_highlight: get('reels-highlight-enabled')
            ? chk('reels-highlight-enabled')
            : (get('reels-karaoke-hl') ? chk('reels-karaoke-hl') : true),

        // Position & Layout
        pos_x: num('reels-pos-x', 50) / 100,
        pos_y: num('reels-pos-y', 85) / 100,
        wrap_width_percent: num('reels-wrap-width', 90),
        auto_wrap: chk('reels-auto-wrap'),
        text_align: val('reels-text-align') || val('reels-adv-textbox-align') || 'center',
        wrap_lines: 2,
        wrap_left: 0,
        wrap_right: 0,
        random_position_use_layout_range: val('reels-anim-in') === 'word_random_position',
        random_position_height_percent: num('reels-random-position-height', 35),
        line_spacing: num('reels-line-spacing', 1.2),
        rotation: num('reels-rotation', 0),

        // Advanced Textbox
        advanced_textbox_enabled: chk('reels-adv-textbox'),
        advanced_textbox_align: val('reels-adv-textbox-align') || 'center',
        advanced_textbox_valign: val('reels-adv-textbox-valign') || 'center',
        advanced_textbox_x: num('reels-adv-x', 200),
        advanced_textbox_y: num('reels-adv-y', 1400),
        advanced_textbox_w: num('reels-adv-w', 680),
        advanced_textbox_h: num('reels-adv-h', 280),
        adv_text_align: val('reels-adv-textbox-align') || 'center',
        
        // Background Mask
        global_mask_enabled: chk('reels-global-mask'),
        global_mask_color: val('reels-global-mask-color') || '#000000',
        global_mask_opacity: num('reels-global-mask-opacity', 128) / 255,

        // 逐字环境光：范围使用画布像素，强度以 UI 百分比保存为 0–1。
        ambient_glow_enabled: chk('reels-ambient-glow-enabled'),
        ambient_glow_color: val('reels-ambient-glow-color') || '#FFFB8F',
        ambient_glow_radius: num('reels-ambient-glow-radius', 650),
        ambient_glow_opacity: num('reels-ambient-glow-opacity', 65) / 100,
        ambient_glow_blend_mode: val('reels-ambient-glow-blend-mode') || 'lighter',
        ambient_lighting_enabled: chk('reels-ambient-lighting-enabled'),
        ambient_dark_color: val('reels-ambient-dark-color') || '#000000',
        ambient_dark_opacity: num('reels-ambient-dark-opacity', 70) / 100,
        ambient_dark_center_opacity: num('reels-ambient-dark-center', 70) / 100,
        ambient_dark_radius: num('reels-ambient-dark-radius', 75) / 100,

        // Background box
        adv_bg_enabled: chk('reels-adv-bg'),
        adv_bg_color: val('reels-adv-bg-color') || '#000000',
        adv_bg_opacity: num('reels-adv-bg-opacity', 150),
        adv_bg_radius: num('reels-adv-bg-radius', 8),

        // Animation
        anim_in_type: val('reels-anim-in') || 'none',
        anim_in_duration: num('reels-anim-in-dur', 0.3),
        anim_in_easing: 'ease_out',
        anim_out_type: val('reels-anim-out') || 'none',
        anim_out_duration: num('reels-anim-out-dur', 0.25),
        anim_out_easing: 'ease_in_out',

        // Animation params
        floating_amplitude: num('reels-float-amp', 8),
        floating_period: num('reels-float-period', 2.0),
        char_bounce_height: num('reels-bounce-height', 20),
        char_bounce_stagger: 0.05,
        char_anim_intensity: num('reels-char-anim-intensity', 1.0),
        char_anim_duration: num('reels-char-anim-duration', 0.28),
        char_anim_stagger: num('reels-char-anim-stagger', 0.04),
        metronome_bpm: num('reels-metro-bpm', 120),
        letter_jump_scale: num('reels-jump-scale', 1.5),
        letter_jump_duration: 0.2,
        word_pop_random_min_scale: num('reels-word-pop-min', 0.7),
        word_pop_random_max_scale: num('reels-word-pop-max', 1.34),
        word_pop_random_duration: num('reels-word-pop-dur', 0.22),
        word_pop_random_pulse_min_scale: num('reels-word-pop-pulse-min', 1.08),
        word_pop_random_pulse_max_scale: num('reels-word-pop-pulse-max', 1.38),
        word_pop_random_pulse_duration: num('reels-word-pop-pulse-dur', 0.22),
        word_pop_random_unread_opacity: num('reels-word-pop-unread-opacity', 0.0),
        word_pop_random_read_opacity: num('reels-word-pop-read-opacity', 1.0),
        random_word_spacing: num('reels-random-word-spacing', 0),
        random_line_spacing: num('reels-random-line-spacing', 0),
        random_spacing_seed: num('reels-random-spacing-seed', 1),
        only_show_active_word: chk('reels-only-show-active-word'),
        flash_color: val('reels-flash-color') || '#FFFFFF',
        flash_duration: 0.1,
        bullet_stagger: 0.15,
        holy_glow_color: val('reels-glow-color') || '#FFFFAA',
        holy_glow_radius: num('reels-glow-radius', 6),
        holy_glow_period: 3.0,
        blur_sharp_max: num('reels-blur-max', 20),
        blur_sharp_clear_frac: 0.4,

        // Typewriter
        typewriter_reveal_type: val('reels-typewriter-reveal-type') || 'word',
        // Empty values deliberately fall back to the normal color controls.
        // Hard-coded values here used to make typewriter ignore those controls.
        tw_revealed_color: '',
        tw_revealed_stroke_color: '',
        tw_unrevealed_color: '#808080',
        tw_unrevealed_stroke_color: '#404040',
        tw_unrevealed_opacity: num('reels-typewriter-unread-opacity', 0) / 255,

        // Metronome
        metro_read_color: val('reels-metro-read-color') || '#FFFFFF',
        metro_read_stroke_color: '#000000',
        metro_unread_color: val('reels-metro-unread-color') || '#808080',
        metro_unread_stroke_color: '#404040',
        metro_unread_opacity: num('reels-metro-unread-opacity', 100),

        // Scrolling lyrics mode
        scrolling_mode: chk('reels-scrolling-mode'),
        scrolling_visible_lines: num('reels-scrolling-lines', 3),
        scrolling_opacity_context: num('reels-scrolling-opacity', 0.3),
        // Fullpage Typewriter
        fullpage_typewriter: chk('reels-fullpage-typewriter'),
        fullpage_typewriter_reveal_type: val('reels-fullpage-typewriter-reveal-type') || 'char',
        fullpage_typewriter_align: val('reels-fullpage-typewriter-align') || 'center',
        fullpage_typewriter_cursor: chk('reels-fullpage-typewriter-cursor'),
        fullpage_typewriter_keep_background: chk('reels-fullpage-typewriter-keep-background'),
        fullpage_typewriter_title_font_follow: chk('reels-fullpage-typewriter-title-font-follow'),
        fullpage_typewriter_title_stroke_independent: chk('reels-fullpage-typewriter-title-stroke-independent'),
        fullpage_typewriter_title_stroke_enabled: chk('reels-fullpage-typewriter-title-stroke-enabled'),
        fullpage_typewriter_title_stroke_color: val('reels-fullpage-typewriter-title-stroke-color') || '#3e2723',
        fullpage_typewriter_title_stroke_width: num('reels-fullpage-typewriter-title-stroke-width', 3),
        fullpage_typewriter_title_stroke_opacity: num('reels-fullpage-typewriter-title-stroke-opacity', 255),
        fullpage_typewriter_title_box_enabled: chk('reels-fullpage-typewriter-title-box-enabled'),
        fullpage_typewriter_title_box_color: val('reels-fullpage-typewriter-title-box-color') || "#000000",
        fullpage_typewriter_title_box_opacity: num('reels-fullpage-typewriter-title-box-opacity', 180),
        fullpage_typewriter_body_stroke_independent: chk('reels-fullpage-typewriter-body-stroke-independent'),
        fullpage_typewriter_body_stroke_enabled: chk('reels-fullpage-typewriter-body-stroke-enabled'),
        fullpage_typewriter_body_stroke_color: val('reels-fullpage-typewriter-body-stroke-color') || '#3e2723',
        fullpage_typewriter_body_stroke_width: num('reels-fullpage-typewriter-body-stroke-width', 3),
        fullpage_typewriter_body_stroke_opacity: num('reels-fullpage-typewriter-body-stroke-opacity', 255),
        fullpage_typewriter_body_box_enabled: chk('reels-fullpage-typewriter-body-box-enabled'),
        fullpage_typewriter_body_box_color: val('reels-fullpage-typewriter-body-box-color') || "#000000",
        fullpage_typewriter_body_box_opacity: num('reels-fullpage-typewriter-body-box-opacity', 180),
        fullpage_typewriter_auto_sequence: chk('reels-fullpage-typewriter-auto-sequence'),
        fullpage_typewriter_split: chk('reels-fullpage-typewriter-split'),
        fullpage_typewriter_title_auto: chk('reels-fullpage-typewriter-title-auto'),
        fullpage_typewriter_title_text: val('reels-fullpage-typewriter-title-text') || "",
        fullpage_typewriter_title_font: val('reels-fullpage-typewriter-title-font') || "",
        fullpage_typewriter_title_size: num('reels-fullpage-typewriter-title-size', 56),
        fullpage_typewriter_title_weight: val('reels-fullpage-typewriter-title-weight') || "700",
        fullpage_typewriter_title_color: val('reels-fullpage-typewriter-title-color') || "#FFD700",
        fullpage_typewriter_title_x: num('reels-fullpage-typewriter-title-x', 50),
        fullpage_typewriter_title_y: num('reels-fullpage-typewriter-title-y', 20),
        fullpage_typewriter_title_delay: num('reels-fullpage-typewriter-title-delay', 0),
        fullpage_typewriter_title_reveal: val('reels-fullpage-typewriter-title-reveal') || "sentence",
        fullpage_typewriter_title_cursor: chk('reels-fullpage-typewriter-title-cursor'),
        fullpage_typewriter_body_reveal: val('reels-fullpage-typewriter-body-reveal') || "sentence",
        fullpage_typewriter_body_delay: num('reels-fullpage-typewriter-body-delay', 0),
        fullpage_typewriter_body_x: num('reels-fullpage-typewriter-body-x', 50),
        fullpage_typewriter_body_y: num('reels-fullpage-typewriter-body-y', 60),
        fullpage_typewriter_body_cursor: chk('reels-fullpage-typewriter-body-cursor'),
        fullpage_typewriter_speech_sync: chk('reels-fullpage-typewriter-speech-sync'),
        fullpage_typewriter_cursor_image: val('reels-fullpage-typewriter-cursor-image'),
        fullpage_typewriter_cursor_image_anchor_x: num('reels-fullpage-typewriter-cursor-image-anchor-x',50),
        fullpage_typewriter_cursor_image_anchor_y: num('reels-fullpage-typewriter-cursor-image-anchor-y',50),
        fullpage_typewriter_cursor_kind: val('reels-fullpage-typewriter-cursor-kind') || 'char',
        fullpage_typewriter_cursor_scale: num('reels-fullpage-typewriter-cursor-scale', 1),
        fullpage_typewriter_cursor_offset_x: num('reels-fullpage-typewriter-cursor-offset-x', 0),
        fullpage_typewriter_cursor_offset_y: num('reels-fullpage-typewriter-cursor-offset-y', 0),
        fullpage_typewriter_cursor_angle: num('reels-fullpage-typewriter-cursor-angle', 0),
        fullpage_typewriter_cursor_char: val('reels-fullpage-typewriter-cursor-char') || '|',
        fullpage_typewriter_cursor_color: val('reels-fullpage-typewriter-cursor-color') || '#FFD700',
        fullpage_typewriter_unrevealed_opacity: num('reels-tw-unrevealed-opacity', 0) / 255,
        fullpage_typewriter_first_line_bold: chk('reels-fullpage-typewriter-first-line-bold'),
        fullpage_typewriter_first_line_scale: num('reels-fullpage-typewriter-first-line-scale', 1.2),
        fullpage_typewriter_first_line_color: chk('reels-fullpage-typewriter-first-line-color-enable') ? val('reels-fullpage-typewriter-first-line-color') : '',
        // Scatter Pop
        scatter_max_words: num('reels-scatter-max-words', 3),
        scatter_accum_prob: num('reels-scatter-accum-prob', 0.5),
        scatter_area_left: num('reels-scatter-area-left', 15),
        scatter_area_right: num('reels-scatter-area-right', 85),
        scatter_area_top: num('reels-scatter-area-top', 25),
        scatter_area_bottom: num('reels-scatter-area-bottom', 75),
        scatter_seed: num('reels-scatter-seed', 1),
        scatter_min_scale: num('reels-scatter-min-scale', 0.8),
        scatter_max_scale: num('reels-scatter-max-scale', 1.5),
        scatter_min_rotate: num('reels-scatter-min-rotate', 0),
        scatter_max_rotate: num('reels-scatter-max-rotate', 0),
    };

    // === Merge with existing hidden state (auto_color_rules etc.) ===
    const existingStyle = _reelsState.style || {};
    const merged = Object.assign({}, existingStyle, baseStyle);
    _reelsState.style = merged;
    return merged;
}

// ═══════════════════════════════════════════════════════
// Subtitle Auto-Color UI
// ═══════════════════════════════════════════════════════

function reelsAddAutoColorRule(type) {
    if (!_reelsState.style) _reelsState.style = _readStyleFromUI();
    if (!_reelsState.style.auto_color_rules) _reelsState.style.auto_color_rules = [];
    
    let defaultKw = [];
    if (type === 'number') defaultKw = ['\d+(\.\d+)?'];
    else if (type === 'english') defaultKw = ["[\\p{L}\\p{M}]+(?:[’'\\-][\\p{L}\\p{M}]+)*"];
    
    _reelsState.style.auto_color_rules.push({
        type: type,
        keywords: defaultKw,
        color: '#FFD700',
        bold: false,
        italic: false,
        fontsize: 0
    });
    
    _persistSubtitleStyleByScope(_reelsState.style);
    _renderSubtitleAutoColorRules();
    reelsUpdatePreview();
}

function _renderSubtitleAutoColorRules() {
    const container = document.getElementById('reels-autocolor-rules');
    if (!container) return;
    container.innerHTML = '';
    
    const style = _reelsState.style;
    if (!style || !style.auto_color_rules || style.auto_color_rules.length === 0) {
        container.innerHTML = '<div style="color:var(--text-secondary,#888);font-size:12px;text-align:center;padding:4px;">(暂无规则)</div>';
        return;
    }

    style.auto_color_rules.forEach((rule, idx) => {
        const ruleDiv = document.createElement('div');
        ruleDiv.style.cssText = 'border:1px solid var(--border-color,#444);border-radius:4px;padding:4px 6px;background:var(--bg-tertiary,#1e1e2d);display:flex;flex-direction:column;gap:4px;';
        
        // Header
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:11px;';
        
        const select = document.createElement('select');
        select.className = 'input input-small';
        select.style.cssText = 'padding:2px 4px;font-size:11px;height:auto;flex:1;';
        const types = { 'keyword': '🏷️ 关键词', 'number': '🔢 数字', 'english': '🔤 单词（多语言）', 'punctuation': '❗ 标点', 'quoted': '「」 引号', 'emoji': '😀 Emoji' };
        for (const [v, n] of Object.entries(types)) {
            const opt = document.createElement('option');
            opt.value = v; opt.textContent = n;
            select.appendChild(opt);
        }
        select.value = rule.type;
        select.addEventListener('change', () => {
            rule.type = select.value;
            if (rule.type === 'number') rule.keywords = ['\\d+(\\.\\d+)?'];
            else if (rule.type === 'english') rule.keywords = ["[\\p{L}\\p{M}]+(?:[’'\\-][\\p{L}\\p{M}]+)*"];
            else if (rule.type === 'punctuation') rule.keywords = ['[!?！？❤️⭐✨🔥💪…]+'];
            else if (rule.type === 'quoted') rule.keywords = ['[「」"\'\'][^「」"\'\']*[「」"\'\']'];
            else if (rule.type === 'emoji') rule.keywords = ['\\p{Emoji_Presentation}|\\p{Extended_Pictographic}'];
            else rule.keywords = [];
            _persistSubtitleStyleByScope(style);
            _renderSubtitleAutoColorRules();
            reelsUpdatePreview();
        });
        header.appendChild(select);
        
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '✕';
        delBtn.style.cssText = 'background:none;border:none;color:var(--danger,#ff4444);cursor:pointer;margin-left:8px;font-size:12px;';
        delBtn.addEventListener('click', () => {
            style.auto_color_rules.splice(idx, 1);
            _persistSubtitleStyleByScope(style);
            _renderSubtitleAutoColorRules();
            reelsUpdatePreview();
        });
        header.appendChild(delBtn);
        ruleDiv.appendChild(header);

        // Keywords Input
        if (rule.type === 'keyword') {
            const kwInput = document.createElement('textarea');
            kwInput.className = 'input';
            kwInput.rows = 2;
            kwInput.style.cssText = 'padding:4px;font-size:11px;min-height:40px;max-height:150px;resize:vertical;width:100%;box-sizing:border-box;';
            kwInput.placeholder = '输入或粘贴词语块\n换行或逗号分隔';
            kwInput.value = (rule.keywords || []).join('\n');
            kwInput.addEventListener('input', () => {
                rule.keywords = kwInput.value.split(/[\n,，]+/).map(s => s.trim()).filter(s => s);
                _persistSubtitleStyleByScope(style);
                reelsUpdatePreview();
            });
            ruleDiv.appendChild(kwInput);
        }

        // Style Row
        const styleRow = document.createElement('div');
        styleRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:2px;';
        
        // Color
        const cPicker = document.createElement('input');
        cPicker.type = 'color';
        cPicker.value = rule.color || '#FFD700';
        cPicker.style.cssText = 'width:24px;height:24px;padding:0;border:none;border-radius:4px;cursor:pointer;';
        cPicker.addEventListener('input', () => {
            rule.color = cPicker.value;
            _persistSubtitleStyleByScope(style);
            reelsUpdatePreview();
        });
        styleRow.appendChild(cPicker);

        // Bold
        const boldLbl = document.createElement('label');
        boldLbl.style.cssText = 'font-size:11px;display:flex;align-items:center;gap:2px;cursor:pointer;';
        const boldChk = document.createElement('input');
        boldChk.type = 'checkbox';
        boldChk.checked = rule.bold;
        boldChk.addEventListener('change', () => {
            rule.bold = boldChk.checked;
            _persistSubtitleStyleByScope(style);
            reelsUpdatePreview();
        });
        boldLbl.appendChild(boldChk);
        boldLbl.appendChild(document.createTextNode('B'));
        styleRow.appendChild(boldLbl);

        // Italic
        const itLbl = document.createElement('label');
        itLbl.style.cssText = 'font-size:11px;display:flex;align-items:center;gap:2px;cursor:pointer;';
        const itChk = document.createElement('input');
        itChk.type = 'checkbox';
        itChk.checked = rule.italic;
        itChk.addEventListener('change', () => {
            rule.italic = itChk.checked;
            _persistSubtitleStyleByScope(style);
            reelsUpdatePreview();
        });
        itLbl.appendChild(itChk);
        itLbl.appendChild(document.createTextNode('I'));
        styleRow.appendChild(itLbl);

        // Font Size
        const fsInput = document.createElement('input');
        fsInput.type = 'number';
        fsInput.className = 'input input-small';
        fsInput.style.cssText = 'width:40px;';
        fsInput.placeholder = '字号';
        if (rule.fontsize) fsInput.value = rule.fontsize;
        fsInput.addEventListener('input', () => {
            const v = parseInt(fsInput.value);
            rule.fontsize = isNaN(v) ? 0 : v;
            _persistSubtitleStyleByScope(style);
            reelsUpdatePreview();
        });
        styleRow.appendChild(fsInput);

        ruleDiv.appendChild(styleRow);
        container.appendChild(ruleDiv);
    });
}

function _writeStyleToUI(style) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) {
            if(id==='reels-fullpage-typewriter-title-font'){
                reelsWritingTitleFontFocus();
                if(val && !Array.from(el.options).some(o=>o.value===val)){const option=document.createElement('option');option.value=val;option.textContent=val;el.appendChild(option);}
            }
            el.value = val;
            el.dataset.rawValue = val;
        }
        const rangeEl = document.getElementById(id + '-range');
        if (rangeEl) rangeEl.value = val;
        const labelEl = document.getElementById(id + '-label');
        if (labelEl) {
            if (id === 'reels-pos-x' || id === 'reels-pos-y' || id === 'reels-wrap-width') {
                labelEl.textContent = val + '%';
            } else {
                labelEl.textContent = val;
            }
        }
        if (id === 'reels-font-family' && typeof getFontManager === 'function') {
            const fm = getFontManager();
            if (fm && typeof fm.refreshFontSelect === 'function') {
                fm.refreshFontSelect(id, val);
            }
        }
    };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

    set('reels-mixed-layout', style.mixed_layout || 'none');
    set('reels-font-family', style.font_family || 'Arial');
    // 如果字体是 Google Font，按需加载。这里以前只启动加载却立即绘制预览：
    // 首帧会落到系统替代字体，而导出会等待字体就绪，导致两边字形/换行不同。
    // 字体真正就绪后必须再画一次当前预览。
    if (typeof getFontManager === 'function') {
        const fm = getFontManager();
        Promise.resolve(fm.loadGoogleFont(style.font_family || 'Arial'))
            .then(() => {
                // 用户可能已切换到另一条任务；重绘会读取当前任务的实际样式，
                // 因此不会把旧字体错误套到新任务上。
                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
            })
            .catch(() => {});
    }
    set('reels-fontsize', style.fontsize || 74);
    set('reels-fontsize-range', style.fontsize || 74);
    const weight = Math.max(100, Math.min(900, parseInt(style.font_weight || ((style.bold !== false) ? 700 : 400), 10) || 700));
    set('reels-font-weight', String(weight));
    setChk('reels-bold', weight >= 600);
    setChk('reels-italic', style.italic);
    setChk('reels-uppercase', style.uppercase);
    set('reels-letter-spacing', style.letter_spacing || 0);
    set('reels-text-direction', style.text_direction || 'auto');
    reelsRefreshSubtitleWeightOptions();
    const colorTextEl = document.getElementById('reels-color-text');
    if (colorTextEl) {
        if (style.color_text && style.color_text.includes(',')) {
            colorTextEl.dataset.gradientValue = style.color_text;
            colorTextEl.value = style.color_text.split(',')[0].trim();
        } else {
            delete colorTextEl.dataset.gradientValue;
            colorTextEl.value = style.color_text || '#FFFFFF';
        }
        colorTextEl.dataset.gradientDirection = style.text_gradient_direction || 'horizontal';
        if (typeof _syncSubtitleGradientSwatch === 'function') {
            _syncSubtitleGradientSwatch(colorTextEl, document.getElementById('reels-color-text-gradient-btn'));
        }
    }
    set('reels-text-gradient-scope', style.text_gradient_scope || 'line');
    const hlEnabled = style.highlight_enabled !== false && style.karaoke_highlight !== false;
    setChk('reels-highlight-enabled', hlEnabled);
    setChk('reels-karaoke-hl', hlEnabled);
    const hlScaleEnabled = Boolean(style.highlight_scale_enabled);
    setChk('reels-highlight-scale-enabled', hlScaleEnabled);
    setChk('reels-anim-highlight-scale-enabled', hlScaleEnabled);
    const hlScaleVal = Number.isFinite(Number(style.highlight_scale)) ? Number(style.highlight_scale) : 125;
    set('reels-highlight-scale', hlScaleVal);
    set('reels-highlight-scale-range', hlScaleVal);
    const hideUntilSpoken = Boolean(style.hide_until_spoken);
    setChk('reels-hide-until-spoken', hideUntilSpoken);
    setChk('reels-anim-hide-until-spoken', hideUntilSpoken);
    const unreadOpacityVal = Number.isFinite(Number(style.unread_opacity)) ? Number(style.unread_opacity) : 0;
    set('reels-unread-opacity', unreadOpacityVal);
    set('reels-unread-opacity-range', unreadOpacityVal);

    const colorHighEl = document.getElementById('reels-color-high');
    if (colorHighEl) {
        if (style.color_high && style.color_high.includes(',')) {
            colorHighEl.dataset.gradientValue = style.color_high;
            colorHighEl.value = style.color_high.split(',')[0].trim();
        } else {
            delete colorHighEl.dataset.gradientValue;
            colorHighEl.value = style.color_high || '#FFD700';
        }
        colorHighEl.dataset.gradientDirection = style.high_gradient_direction || 'horizontal';
        if (typeof _syncSubtitleGradientSwatch === 'function') {
            _syncSubtitleGradientSwatch(colorHighEl, document.getElementById('reels-color-high-gradient-btn'));
        }
    }
    setChk('reels-use-stroke', style.use_stroke !== false);
    set('reels-stroke-color', style.color_outline || '#3E2723');
    set('reels-stroke-width', style.border_width || 3);
    setChk('reels-stroke-expand', style.stroke_expand_enabled);
    set('reels-se-layers', style.stroke_expand_layers || 3);
    set('reels-se-step', style.stroke_expand_step || 4);
    set('reels-se-feather', style.stroke_expand_feather || 8);
    set('reels-se-colors', typeof style.stroke_expand_colors === 'string' ? style.stroke_expand_colors : '#FF0000,#00FF00,#0000FF');
    if (typeof window.reelsSyncSEColorsUI === 'function') window.reelsSyncSEColorsUI();
    setChk('reels-shadow', (style.shadow_blur || 0) > 0);
    set('reels-shadow-color', style.color_shadow || '#000000');
    set('reels-shadow-blur', style.shadow_blur || 4);
    set('reels-shadow-offset-x', style.shadow_offset_x ?? 0);
    set('reels-shadow-offset-y', style.shadow_offset_y ?? 2);
    setChk('reels-use-box', style.use_box || style.box_wipe_enabled || style.anim_in_type === 'box_wipe');
    setChk('reels-box-adaptive-width', style.box_adaptive_width || style.box_wipe_enabled || style.anim_in_type === 'box_wipe');
    setChk('reels-box-connected', (style.box_wipe_enabled || style.anim_in_type === 'box_wipe') ? false : (style.box_connected !== false));
    setChk('reels-box-wipe', Boolean(style.box_wipe_enabled || style.anim_in_type === 'box_wipe'));
    set('reels-box-concave-radius', style.box_concave_radius ?? 10);
    set('reels-box-concave-radius-range', style.box_concave_radius ?? 10);
    set('reels-box-snap-threshold', style.box_snap_threshold ?? 18);
    set('reels-box-snap-threshold-range', style.box_snap_threshold ?? 18);
    set('reels-box-brush-style', style.box_brush_style || 'rect');
    set('reels-box-brush-color-mode', style.box_brush_color_mode || 'tint');
    set('reels-box-custom-brush-data', style.box_custom_brush_data || '');
    set('reels-box-brush-w', style.box_brush_w ?? 0);
    set('reels-box-brush-h', style.box_brush_h ?? 0);
    set('reels-box-brush-x', style.box_brush_x ?? 0);
    set('reels-box-brush-y', style.box_brush_y ?? 0);
    set('reels-box-brush-solid', style.box_brush_solid ?? 100);
    { const el = document.getElementById('reels-box-brush-w-range'); if (el) el.value = style.box_brush_w ?? 0; }
    { const el = document.getElementById('reels-box-brush-h-range'); if (el) el.value = style.box_brush_h ?? 0; }
    { const el = document.getElementById('reels-box-brush-x-range'); if (el) el.value = style.box_brush_x ?? 0; }
    { const el = document.getElementById('reels-box-brush-y-range'); if (el) el.value = style.box_brush_y ?? 0; }
    { const el = document.getElementById('reels-box-brush-solid-range'); if (el) el.value = style.box_brush_solid ?? 100; }
    // This is a programmatic style restore during task switching.  Do not open
    // the file picker when the saved brush style happens to be "custom".
    if (typeof window.reelsOnBoxBrushStyleChange === 'function') window.reelsOnBoxBrushStyleChange(false);
    set('reels-box-color', style.color_bg || '#000000');
    set('reels-box-opacity', style.opacity_bg ?? 150);
    set('reels-box-radius', style.box_radius ?? 8);
    set('reels-box-pad-x', style.box_padding_x ?? 12);
    set('reels-box-pad-y', style.box_padding_y ?? 8);
    { const el = document.getElementById('reels-box-pad-x-range'); if (el) el.value = style.box_padding_x ?? 12; }
    { const el = document.getElementById('reels-box-pad-y-range'); if (el) el.value = style.box_padding_y ?? 8; }
    set('reels-box-blur', style.box_blur || 0);
    setChk('reels-bg-gradient', style.bg_gradient_enabled);
    set('reels-bg-gradient-type', style.bg_gradient_type || 'linear_h');
    set('reels-bg-gradient-colors', typeof style.bg_gradient_colors === 'string' ? style.bg_gradient_colors : '#e0c3fc,#8ec5fc');
    setChk('reels-bg-gradient-hl', style.bg_gradient_highlight);
    if (typeof window.reelsSyncBgGradientColorsUI === 'function') window.reelsSyncBgGradientColorsUI();
    setChk('reels-box-transition', style.box_transition_enabled);
    set('reels-box-transition-color', style.box_transition_color_to || '#FF6600');
    setChk('reels-dynamic-box', style.dynamic_box);
    setChk('reels-dynamic-box-stroke', style.dynamic_box_stroke);
    set('reels-dynamic-box-stroke-width', style.dynamic_box_stroke_width ?? 2);
    set('reels-high-bg-color', style.color_high_bg || '#FFD700');
    set('reels-high-bg-opacity', style.opacity_high_bg ?? 200);
    { const el = document.getElementById('reels-high-bg-opacity-range'); if (el) el.value = style.opacity_high_bg ?? 200; }
    setChk('reels-dyn-anim', style.dyn_box_anim);
    set('reels-high-padding', style.high_padding ?? 4);
    set('reels-dyn-radius', style.dynamic_radius ?? 6);
    setChk('reels-use-underline', style.use_underline);
    set('reels-underline-color', style.color_underline || '#FFD700');
    set('reels-pos-x', Math.round((style.pos_x || 0.5) * 100));
    set('reels-pos-y', Math.round((style.pos_y || 0.5) * 100));
    set('reels-wrap-width', style.wrap_width_percent || 90);
    setChk('reels-auto-wrap', style.auto_wrap !== false);
    set('reels-text-align', style.text_align || style.advanced_textbox_align || 'center');
    set('reels-random-position-height', style.random_position_height_percent || 35);
    set('reels-random-position-height-range', style.random_position_height_percent || 35);
    set('reels-line-spacing', style.line_spacing ?? 4);
    set('reels-rotation', style.rotation || 0);
    setChk('reels-adv-textbox', style.advanced_textbox_enabled);
    set('reels-adv-textbox-align', style.advanced_textbox_align || 'center');
    set('reels-adv-textbox-valign', style.advanced_textbox_valign || 'center');

    // Global mask
    setChk('reels-global-mask', style.global_mask_enabled);
    set('reels-global-mask-color', style.global_mask_color || '#000000');
    const globalMaskOpacity = Math.round((style.global_mask_opacity ?? 0.5) * 255);
    set('reels-global-mask-opacity', globalMaskOpacity);
    set('reels-global-mask-opacity-range', globalMaskOpacity);
    setChk('reels-ambient-glow-enabled', style.ambient_glow_enabled);
    set('reels-ambient-glow-color', style.ambient_glow_color || '#FFFB8F');
    set('reels-ambient-glow-radius', style.ambient_glow_radius ?? 650);
    set('reels-ambient-glow-radius-range', style.ambient_glow_radius ?? 650);
    set('reels-ambient-glow-blend-mode', style.ambient_glow_blend_mode || 'lighter');
    setChk('reels-ambient-lighting-enabled', style.ambient_lighting_enabled);
    set('reels-ambient-dark-color', style.ambient_dark_color || '#000000');
    const ambientDarkPercent = Math.round((style.ambient_dark_opacity ?? .70) * 100);
    set('reels-ambient-dark-opacity', ambientDarkPercent);
    set('reels-ambient-dark-opacity-range', ambientDarkPercent);
    const ambientDarkCenterPercent = Math.round((style.ambient_dark_center_opacity ?? .70) * 100);
    set('reels-ambient-dark-center', ambientDarkCenterPercent);
    set('reels-ambient-dark-center-range', ambientDarkCenterPercent);
    const ambientDarkRadiusPercent = Math.round((style.ambient_dark_radius ?? .75) * 100);
    set('reels-ambient-dark-radius', ambientDarkRadiusPercent);
    set('reels-ambient-dark-radius-range', ambientDarkRadiusPercent);
    const ambientOpacityPercent = Math.round((style.ambient_glow_opacity ?? .65) * 100);
    set('reels-ambient-glow-opacity', ambientOpacityPercent);
    set('reels-ambient-glow-opacity-range', ambientOpacityPercent);

    set('reels-adv-x', style.advanced_textbox_x || 200);
    set('reels-adv-y', style.advanced_textbox_y || 1400);
    set('reels-adv-w', style.advanced_textbox_w || 680);
    set('reels-adv-h', style.advanced_textbox_h || 280);
    setChk('reels-adv-bg', style.adv_bg_enabled);
    set('reels-adv-bg-color', style.adv_bg_color || '#000000');
    set('reels-adv-bg-opacity', style.adv_bg_opacity || 150);
    set('reels-adv-bg-radius', style.adv_bg_radius || 8);
    set('reels-anim-in', style.anim_in_type || 'fade');
    set('reels-anim-in-dur', style.anim_in_duration || 0.3);
    set('reels-anim-out', style.anim_out_type || 'fade');
    set('reels-anim-out-dur', style.anim_out_duration || 0.25);
    set('reels-float-amp', style.floating_amplitude || 8);
    set('reels-float-period', style.floating_period || 2);
    set('reels-bounce-height', style.char_bounce_height || 20);
    set('reels-char-anim-intensity', style.char_anim_intensity ?? 1.0);
    set('reels-char-anim-intensity-range', style.char_anim_intensity ?? 1.0);
    set('reels-char-anim-duration', style.char_anim_duration ?? 0.28);
    set('reels-char-anim-duration-range', style.char_anim_duration ?? 0.28);
    set('reels-char-anim-stagger', style.char_anim_stagger ?? 0.04);
    set('reels-char-anim-stagger-range', style.char_anim_stagger ?? 0.04);
    set('reels-metro-bpm', style.metronome_bpm || 120);
    set('reels-jump-scale', style.letter_jump_scale || 1.5);
    set('reels-flash-color', style.flash_color || '#FFFFFF');
    set('reels-glow-color', style.holy_glow_color || '#FFFFAA');
    set('reels-glow-radius', style.holy_glow_radius || 6);
    set('reels-blur-max', style.blur_sharp_max || 20);
    set('reels-typewriter-reveal-type', style.typewriter_reveal_type || 'word');
    set('reels-random-word-spacing', style.random_word_spacing || 0);
    set('reels-random-word-spacing-range', style.random_word_spacing || 0);
    set('reels-random-line-spacing', style.random_line_spacing || 0);
    set('reels-random-line-spacing-range', style.random_line_spacing || 0);
    set('reels-random-spacing-seed', style.random_spacing_seed || 1);
    setChk('reels-only-show-active-word', style.only_show_active_word);
    set('reels-metro-read-color', style.metro_read_color || '#FFFFFF');
    set('reels-metro-unread-color', style.metro_unread_color || '#808080');
    set('reels-metro-unread-opacity', style.metro_unread_opacity ?? 100);
    set('reels-metro-unread-opacity-range', style.metro_unread_opacity ?? 100);
    const normalTypewriterUnreadOpacity = Number(style.tw_unrevealed_opacity ?? 0);
    const normalTypewriterUnreadOpacity255 = Math.round(Math.max(0, Math.min(255,
        normalTypewriterUnreadOpacity > 1 ? normalTypewriterUnreadOpacity : normalTypewriterUnreadOpacity * 255)));
    set('reels-typewriter-unread-opacity', normalTypewriterUnreadOpacity255);
    set('reels-typewriter-unread-opacity-range', normalTypewriterUnreadOpacity255);

    // Scrolling lyrics mode
    setChk('reels-scrolling-mode', style.scrolling_mode);
    set('reels-scrolling-lines', style.scrolling_visible_lines || 3);
    set('reels-scrolling-opacity', style.scrolling_opacity_context || 0.3);
    // Toggle visibility of scrolling sub-options
    const scrollOpts = document.getElementById('reels-scrolling-options');
    if (scrollOpts) scrollOpts.style.display = style.scrolling_mode ? '' : 'none';

    // Fullpage Typewriter
    setChk('reels-fullpage-typewriter', style.fullpage_typewriter);
    set('reels-fullpage-typewriter-reveal-type', style.fullpage_typewriter_reveal_type || 'char');
    set('reels-fullpage-typewriter-align', style.fullpage_typewriter_align || 'center');
    setChk('reels-fullpage-typewriter-cursor', style.fullpage_typewriter_cursor !== false);
    setChk('reels-fullpage-typewriter-keep-background', style.fullpage_typewriter_keep_background ?? true);
    setChk('reels-fullpage-typewriter-title-font-follow', style.fullpage_typewriter_title_font_follow ?? true);
    setChk('reels-fullpage-typewriter-title-stroke-independent', style.fullpage_typewriter_title_stroke_independent);
    setChk('reels-fullpage-typewriter-title-stroke-enabled', style.fullpage_typewriter_title_stroke_enabled ?? style.use_stroke ?? true);
    set('reels-fullpage-typewriter-title-stroke-color', style.fullpage_typewriter_title_stroke_color ?? style.color_outline ?? '#3e2723');
    set('reels-fullpage-typewriter-title-stroke-width', style.fullpage_typewriter_title_stroke_width ?? style.border_width ?? 3);
    set('reels-fullpage-typewriter-title-stroke-opacity', style.fullpage_typewriter_title_stroke_opacity ?? style.opacity_outline ?? 255);
    setChk('reels-fullpage-typewriter-title-box-enabled', style.fullpage_typewriter_title_box_enabled ?? style.use_box ?? true);
    set('reels-fullpage-typewriter-title-box-color', style.fullpage_typewriter_title_box_color ?? style.color_bg ?? "#000000");
    set('reels-fullpage-typewriter-title-box-opacity', style.fullpage_typewriter_title_box_opacity ?? style.opacity_bg ?? 180);
    setChk('reels-fullpage-typewriter-body-stroke-independent', style.fullpage_typewriter_body_stroke_independent);
    setChk('reels-fullpage-typewriter-body-stroke-enabled', style.fullpage_typewriter_body_stroke_enabled ?? style.use_stroke ?? true);
    set('reels-fullpage-typewriter-body-stroke-color', style.fullpage_typewriter_body_stroke_color ?? style.color_outline ?? '#3e2723');
    set('reels-fullpage-typewriter-body-stroke-width', style.fullpage_typewriter_body_stroke_width ?? style.border_width ?? 3);
    set('reels-fullpage-typewriter-body-stroke-opacity', style.fullpage_typewriter_body_stroke_opacity ?? style.opacity_outline ?? 255);
    setChk('reels-fullpage-typewriter-body-box-enabled', style.fullpage_typewriter_body_box_enabled ?? style.use_box ?? true);
    set('reels-fullpage-typewriter-body-box-color', style.fullpage_typewriter_body_box_color ?? style.color_bg ?? "#000000");
    set('reels-fullpage-typewriter-body-box-opacity', style.fullpage_typewriter_body_box_opacity ?? style.opacity_bg ?? 180);
    setChk('reels-fullpage-typewriter-auto-sequence', style.fullpage_typewriter_auto_sequence ?? true);
    setChk('reels-fullpage-typewriter-split', style.fullpage_typewriter_split ?? false);
    setChk('reels-fullpage-typewriter-title-auto', style.fullpage_typewriter_title_auto ?? true);
    set('reels-fullpage-typewriter-title-text', style.fullpage_typewriter_title_text ?? "");
    set('reels-fullpage-typewriter-title-font', style.fullpage_typewriter_title_font ?? "");
    set('reels-fullpage-typewriter-title-size', style.fullpage_typewriter_title_size ?? 56);
    set('reels-fullpage-typewriter-title-weight', style.fullpage_typewriter_title_weight ?? "700");
    set('reels-fullpage-typewriter-title-color', style.fullpage_typewriter_title_color ?? "#FFD700");
    set('reels-fullpage-typewriter-title-x', style.fullpage_typewriter_title_x ?? 50);
    set('reels-fullpage-typewriter-title-y', style.fullpage_typewriter_title_y ?? 20);
    set('reels-fullpage-typewriter-title-delay', style.fullpage_typewriter_title_delay ?? 0);
    set('reels-fullpage-typewriter-title-reveal', style.fullpage_typewriter_title_reveal ?? "sentence");
    setChk('reels-fullpage-typewriter-title-cursor', style.fullpage_typewriter_title_cursor ?? true);
    set('reels-fullpage-typewriter-body-reveal', style.fullpage_typewriter_body_reveal ?? "sentence");
    set('reels-fullpage-typewriter-body-delay', style.fullpage_typewriter_body_delay ?? 0);
    set('reels-fullpage-typewriter-body-x', style.fullpage_typewriter_body_x ?? 50);
    set('reels-fullpage-typewriter-body-y', style.fullpage_typewriter_body_y ?? 60);
    setChk('reels-fullpage-typewriter-body-cursor', style.fullpage_typewriter_body_cursor ?? true);
    reelsRefreshWritingTitleEditor();
    requestAnimationFrame(() => window.reelsWritingTitleFontChanged());
    setChk('reels-fullpage-typewriter-speech-sync', style.fullpage_typewriter_speech_sync ?? true);
    set('reels-fullpage-typewriter-cursor-image', style.fullpage_typewriter_cursor_image || '');
    set('reels-fullpage-typewriter-cursor-image-anchor-x', style.fullpage_typewriter_cursor_image_anchor_x ?? 50);
    set('reels-fullpage-typewriter-cursor-image-anchor-y', style.fullpage_typewriter_cursor_image_anchor_y ?? 50);
    set('reels-fullpage-typewriter-cursor-kind', style.fullpage_typewriter_cursor_kind ?? "char");
    reelsRefreshSpeechWritingImageUI();
    set('reels-fullpage-typewriter-cursor-scale', style.fullpage_typewriter_cursor_scale ?? 1);
    set('reels-fullpage-typewriter-cursor-offset-x', style.fullpage_typewriter_cursor_offset_x ?? 0);
    set('reels-fullpage-typewriter-cursor-offset-y', style.fullpage_typewriter_cursor_offset_y ?? 0);
    set('reels-fullpage-typewriter-cursor-angle', style.fullpage_typewriter_cursor_angle ?? 0);
    set('reels-fullpage-typewriter-cursor-char', style.fullpage_typewriter_cursor_char || '|');
    set('reels-fullpage-typewriter-cursor-color', style.fullpage_typewriter_cursor_color || '#FFD700');
    const fullpageTypewriterUnreadOpacity = Number(style.fullpage_typewriter_unrevealed_opacity ?? style.tw_unrevealed_opacity ?? 0);
    set('reels-tw-unrevealed-opacity', Math.round(Math.max(0, Math.min(255,
        fullpageTypewriterUnreadOpacity > 1 ? fullpageTypewriterUnreadOpacity : fullpageTypewriterUnreadOpacity * 255))));
    setChk('reels-fullpage-typewriter-first-line-bold', style.fullpage_typewriter_first_line_bold !== false);
    set('reels-fullpage-typewriter-first-line-scale', style.fullpage_typewriter_first_line_scale ?? 1.2);
    set('reels-fullpage-typewriter-first-line-color', style.fullpage_typewriter_first_line_color || '#FFFFFF');
    setChk('reels-fullpage-typewriter-first-line-color-enable', !!style.fullpage_typewriter_first_line_color);
    const twOpts = document.getElementById('reels-fullpage-typewriter-options');
    if (twOpts) twOpts.style.display = style.fullpage_typewriter ? '' : 'none';

    // Scatter Pop
    set('reels-scatter-max-words', style.scatter_max_words ?? 3);
    set('reels-scatter-accum-prob', style.scatter_accum_prob ?? 0.5);
    set('reels-scatter-area-left', style.scatter_area_left ?? 15);
    set('reels-scatter-area-left-range', style.scatter_area_left ?? 15);
    set('reels-scatter-area-right', style.scatter_area_right ?? 85);
    set('reels-scatter-area-right-range', style.scatter_area_right ?? 85);
    set('reels-scatter-area-top', style.scatter_area_top ?? 25);
    set('reels-scatter-area-top-range', style.scatter_area_top ?? 25);
    set('reels-scatter-area-bottom', style.scatter_area_bottom ?? 75);
    set('reels-scatter-area-bottom-range', style.scatter_area_bottom ?? 75);
    set('reels-scatter-seed', style.scatter_seed ?? 1);
    set('reels-scatter-min-scale', style.scatter_min_scale ?? 0.8);
    set('reels-scatter-max-scale', style.scatter_max_scale ?? 1.5);
    set('reels-scatter-min-rotate', style.scatter_min_rotate ?? 0);
    set('reels-scatter-max-rotate', style.scatter_max_rotate ?? 0);

    // 当前 UI 缓存必须属于“刚载入的这一套样式”。此前用 merge 保留上一套
    // 未出现在新对象中的字段（自动着色、动效等），切换全部/独立后再保存时
    // 就会把两套样式混合，表现为明明没改却字体/描边/动效改变。
    _reelsState.style = _cloneSubtitleStyle(style) || {};

    _renderSubtitleAutoColorRules();
    reelsRefreshAnimationParameterAvailability();
}

// ═══════════════════════════════════════════════════════
// Preview rendering loop (with RAF coalescing to prevent UI freeze)
// ═══════════════════════════════════════════════════════

let _reelsUpdatePreviewRaf = null;
function reelsUpdatePreview(immediate = false) {
    if (immediate) {
        if (_reelsUpdatePreviewRaf) {
            cancelAnimationFrame(_reelsUpdatePreviewRaf);
            _reelsUpdatePreviewRaf = null;
        }
        _reelsUpdatePreviewInternal();
        return;
    }
    if (_reelsUpdatePreviewRaf) return;
    _reelsUpdatePreviewRaf = requestAnimationFrame(() => {
        _reelsUpdatePreviewRaf = null;
        _reelsUpdatePreviewInternal();
    });
}

function _reelsUpdatePreviewInternal() {
    reelsRefreshAnimationParameterAvailability();
    // 独立预览打开时由 ReelsPreviewV2 自己驱动画布。旧预览即使已隐藏，过去
    // 仍会继续运行并操作 ReelsOverlay 共用的视频缓存：V2 seek 到当前时间，
    // 旧预览又按自己的 0 秒 seek 回去，插入视频因此永远拿不到稳定帧。
    if (window.ReelsPreviewV2?.isOpen?.()) return;
    const renderer = _reelsState.renderer;
    if (!renderer) return;

    const style = getWritingVisualStyle(_readStyleFromUI());
    // 预览必须是纯读取：任务切换、播放器 timeupdate、字体异步加载都会调用它。
    // 在这里写入会把旧任务的 UI 样式误存进新任务/新作用域。
    const previewText = (document.getElementById('reels-preview-text') || {}).value || 'Hello World 这是一个测试字幕';
    const canvas = renderer.canvas;
    const ctx = renderer.ctx;
    const w = canvas.width;
    const h = canvas.height;

    const placeholder = document.getElementById('reels-preview-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    renderer.clear();
    _syncBackgroundVideoToMaster();

    const video = document.getElementById('reels-preview-video');
    const hookVideo = document.getElementById('reels-preview-hook-video');
    // Check for image background
    let bgImg = _reelsState._previewBgImage;
    let hasBgImg = bgImg && bgImg.complete && bgImg.naturalWidth > 0;

    // Removed noisy debug logs

    const _selectedTask = _getSelectedTask();
    const _bgScalePct = _selectedTask ? (_selectedTask.bgScale || 100) : 100;
    const _bgRotation = Number(_selectedTask?.bgRotation) || 0;
    const _bgXPct = _selectedTask ? (_selectedTask.bgX || 0) : 0;
    const _bgYPct = _selectedTask ? (_selectedTask.bgY || 0) : 0;

    // ── 检查并更新极速贴合提示 ──
    const fastAlphaCb = document.getElementById('reels-fast-alpha-mode');
    const fastAlphaStatusEl = document.getElementById('fast-alpha-status-text');
    if (fastAlphaCb && fastAlphaStatusEl && _selectedTask) {
        const exportEngine = (document.getElementById('reels-export-engine') || {}).value || 'precise';
        const fastEnabled = fastAlphaCb.checked || exportEngine === 'pipeline' || exportEngine === 'hardware';
        if (!fastEnabled) {
            fastAlphaStatusEl.style.display = 'none';
        } else {
            const capability = _getReelsFastExportCapability(_selectedTask, _reelsState.bgPath || '');
            if (!capability.supported) {
                fastAlphaStatusEl.style.display = 'inline-block';
                fastAlphaStatusEl.style.color = '#faad14';
                fastAlphaStatusEl.style.background = '#fffbe6';
                fastAlphaStatusEl.style.border = '1px solid #ffe58f';
                fastAlphaStatusEl.textContent = `当前自动回退逐帧背景（${capability.reason}）`;
            } else {
                fastAlphaStatusEl.style.display = 'inline-block';
                fastAlphaStatusEl.style.color = '#52c41a';
                fastAlphaStatusEl.style.background = '#f6ffed';
                fastAlphaStatusEl.style.border = '1px solid #b7eb8f';
                fastAlphaStatusEl.textContent = '✓ 支持提速';
            }
        }
    }

    // ── Phase calculations ──
    const inCoverEditMode = !!_reelsState._coverEditMode;
    const coverDur = (_selectedTask && _selectedTask.cover && _selectedTask.cover.enabled) ? (parseFloat(_selectedTask.cover.duration) || 0.01) : 0;
    const hookDur = _reelsState.hookDuration || 0;
    const totalTime = _getPreviewCurrentTime();
    

    // 如果在【封面编辑模式】，强制进入 CoverPhase
    const inCoverPhase = inCoverEditMode || (coverDur > 0 && totalTime < coverDur);
    _reelsState.coverPhase = inCoverPhase;

    // Hook 阶段偏移
    const inHookPhase = !inCoverEditMode && (hookDur > 0 && totalTime >= coverDur && totalTime < (coverDur + hookDur));
    _reelsState.hookPhase = inHookPhase;

    const contentTime = Math.max(0, totalTime - coverDur - hookDur);
    let multiClips = null;
    if (_selectedTask && _selectedTask.bgMode === 'multi' && !inCoverPhase && !inHookPhase) {
        multiClips = _syncPreviewMultiBackground(_selectedTask, contentTime);
        bgImg = null;
        hasBgImg = false;
    }

    // ── 准备内容视频源 (以防作为毛玻璃背景或前景使用) ──
    let cvDrawSource = null;
    let cvW = 0, cvH = 0;
    if (_selectedTask && _selectedTask.contentVideoPath) {
        const contentVideoEl = document.getElementById('reels-preview-contentvideo');
        const contentImg = _reelsState.previewContentImage;
        let seqImg = null;
        if (_reelsState.cvSequence && _reelsState.cvSequence.path === _selectedTask.contentVideoPath && _reelsState.cvSequence.files.length > 0) {
            const fps = 30;
            let frameIdx = Math.floor(_getPreviewCurrentTime() * fps);
            frameIdx = frameIdx % _reelsState.cvSequence.files.length;
            const frameFile = _reelsState.cvSequence.files[frameIdx];
            seqImg = _reelsState.cvSequence.loadedImages[frameFile];
        }

        if (seqImg && seqImg.complete && seqImg.naturalWidth > 0) {
            cvDrawSource = seqImg;
            cvW = seqImg.naturalWidth;
            cvH = seqImg.naturalHeight;
        } else if (contentImg && contentImg.complete && contentImg.naturalWidth > 0) {
            cvDrawSource = contentImg;
            cvW = contentImg.naturalWidth;
            cvH = contentImg.naturalHeight;
        } else if (contentVideoEl && contentVideoEl.src && contentVideoEl.readyState >= 1 && contentVideoEl.videoWidth > 0) {
            cvDrawSource = contentVideoEl;
            cvW = contentVideoEl.videoWidth;
            cvH = contentVideoEl.videoHeight;
        }
    }

    // ── Cover 阶段渲染 ──
    if (inCoverPhase) {
        let coverBgScale = (_selectedTask && _selectedTask.cover && _selectedTask.cover.bgScale) || _bgScalePct;
        let coverBgRotation = Number(_selectedTask?.cover?.bgRotation ?? _selectedTask?.bgRotation) || 0;
        let coverBgX = (_selectedTask && _selectedTask.cover && _selectedTask.cover.bgX) || _bgXPct;
        let coverBgY = (_selectedTask && _selectedTask.cover && _selectedTask.cover.bgY) || _bgYPct;
        let coverBgFlipH = (_selectedTask && _selectedTask.cover && _selectedTask.cover.bgFlipH) || (_selectedTask && _selectedTask.bgFlipH) || false;
        let coverBgFlipV = (_selectedTask && _selectedTask.cover && _selectedTask.cover.bgFlipV) || (_selectedTask && _selectedTask.bgFlipV) || false;
        if (_reelsState._previewCoverVideo && _reelsState._previewCoverVideo.readyState >= 1) {
            const coverVideo = _reelsState._previewCoverVideo;
            const coverTarget = coverVideo.duration > 0 ? Math.min(totalTime, Math.max(0, coverVideo.duration - 0.03)) : totalTime;
            if (!coverVideo.seeking && Math.abs((coverVideo.currentTime || 0) - coverTarget) > 0.08) {
                try { coverVideo.currentTime = coverTarget; } catch (e) { }
            }
        }
        if (_reelsState._previewCoverImage && _reelsState._previewCoverImage.complete && _reelsState._previewCoverImage.naturalWidth > 0) {
            _drawVideoCover(ctx, _reelsState._previewCoverImage, w, h, coverBgScale, coverBgX, coverBgY, coverBgFlipH, coverBgFlipV, coverBgRotation);
        } else if (_reelsState._previewCoverVideo && _reelsState._previewCoverVideo.readyState >= 1) {
            _drawVideoCover(ctx, _reelsState._previewCoverVideo, w, h, coverBgScale, coverBgX, coverBgY, coverBgFlipH, coverBgFlipV, coverBgRotation);
        } else if (hasBgImg) {
            _drawVideoCover(ctx, bgImg, w, h, coverBgScale, coverBgX, coverBgY, coverBgFlipH, coverBgFlipV, coverBgRotation);
        } else if (video && video.readyState >= 1) {
            _drawVideoCover(ctx, video, w, h, coverBgScale, coverBgX, coverBgY, coverBgFlipH, coverBgFlipV, coverBgRotation);
        } else {
            ctx.fillStyle = '#000'; ctx.fillRect(0,0,w,h);
        }
    } 
    // ── Hook 阶段渲染 (在 Hook 阶段绘制 Hook 视频代替背景) ──
    else if (inHookPhase && hookVideo && hookVideo.src && hookVideo.readyState >= 1 && hookVideo.videoWidth > 0) {
        // 同步 Hook 视频 currentTime 与 mock 时钟，防止漂移
        if (_selectedTask) {
            const trimStart = (_selectedTask.hookTrimStart != null && _selectedTask.hookTrimStart > 0) ? _selectedTask.hookTrimStart : 0;
            const speed = _selectedTask.hookSpeed || 1.0;
            const expectedHookTime = trimStart + ((totalTime - coverDur) * speed);
            if (hookVideo.readyState >= 2 && !hookVideo.seeking && Math.abs(hookVideo.currentTime - expectedHookTime) > 0.3) {
                try { hookVideo.currentTime = expectedHookTime; } catch (e) { }
            }
        }
        _drawVideoCover(ctx, hookVideo, w, h, 100);

        // Hook → Main 转场 (读取 task 配置 of 转场类型 和 时长，与导出一致)
        const hookTransition = (_selectedTask && _selectedTask.hookTransition) || 'none';
        const transitionDur = hookTransition !== 'none' ? ((_selectedTask && _selectedTask.hookTransDuration) || 0.5) : 0;
        const timeToEnd = (coverDur + hookDur) - totalTime;
        if (transitionDur > 0 && timeToEnd < transitionDur && video && video.src && video.readyState >= 1 && video.videoWidth > 0) {
            const alpha = 1.0 - (timeToEnd / transitionDur);
            ctx.save();
            ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
            _drawVideoCover(ctx, video, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false, _bgRotation);
            ctx.restore();
        }
    } else if (_selectedTask && _selectedTask.contentVideoBlurBg && cvDrawSource && cvW > 0) {
        // 使用内容视频裁切后的毛玻璃背景
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, w, h);

        const { cropX, cropY, cropW, cropH } = _parseCropString(_selectedTask.contentVideoCrop);
        ctx.save();
        const blurVal = _selectedTask.contentVideoBlur != null ? _selectedTask.contentVideoBlur : 40;
        const brightnessVal = (_selectedTask.contentVideoBrightness != null ? _selectedTask.contentVideoBrightness : 60) / 100;
        ctx.filter = `blur(${blurVal}px) brightness(${brightnessVal})`;
        _drawCroppedVideoCover(ctx, cvDrawSource, cropX, cropY, cropW, cropH, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false, _bgRotation);
        ctx.restore();

        // Draw global mask if enabled
        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    } else if (_selectedTask && _selectedTask.contentVideoDirectBg && cvDrawSource && cvW > 0) {
        // 直接使用内容视频作为背景（不模糊铺满）
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, w, h);

        const { cropX, cropY, cropW, cropH } = _parseCropString(_selectedTask.contentVideoCrop);
        _drawCroppedVideoCover(ctx, cvDrawSource, cropX, cropY, cropW, cropH, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false, _bgRotation);

        // Draw global mask if enabled
        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    } else if (_selectedTask && _selectedTask.bgMode === 'multi' && !inCoverPhase && !inHookPhase) {
        _drawPreviewMultiBackground(ctx, w, h, _bgScalePct, _bgXPct, _bgYPct, _bgRotation, multiClips);
        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    } else if (video && video.src && video.readyState >= 1 && video.videoWidth > 0) {
        _drawVideoCover(ctx, video, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false, _bgRotation);
        const fadeFrame = _calcPreviewLoopFadeFrame();
        if (fadeFrame && fadeFrame.video && fadeFrame.video.readyState >= 2) {
            ctx.save();
            ctx.globalAlpha = fadeFrame.alpha;
            _drawVideoCover(ctx, fadeFrame.video, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false, _bgRotation);
            ctx.restore();
        }

        // Draw global mask if enabled
        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    } else if (hasBgImg) {
        // Draw image background using cover mode
        _drawVideoCover(ctx, bgImg, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false, _bgRotation);

        // Draw global mask if enabled
        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    } else {
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#181818');
        grad.addColorStop(0.5, '#1e1e1e');
        grad.addColorStop(1, '#2a2a2a');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    }

    // --- Content Video or Image ---
    const contentVideoEl = document.getElementById('reels-preview-contentvideo');
    const contentImg = _reelsState.previewContentImage;
    if (_selectedTask && _selectedTask.contentVideoPath && !_selectedTask.contentVideoDirectBg) {
        let drawSource = null;
        let cvW = 0, cvH = 0;
        
        let seqImg = null;
        if (_reelsState.cvSequence && _reelsState.cvSequence.path === _selectedTask.contentVideoPath && _reelsState.cvSequence.files.length > 0) {
            const fps = 30;
            // loop sequence:
            let frameIdx = Math.floor(_getPreviewCurrentTime() * fps);
            frameIdx = frameIdx % _reelsState.cvSequence.files.length;
            const frameFile = _reelsState.cvSequence.files[frameIdx];
            seqImg = _reelsState.cvSequence.loadedImages[frameFile];
        }

        if (seqImg && seqImg.complete && seqImg.naturalWidth > 0) {
            drawSource = seqImg;
            cvW = seqImg.naturalWidth;
            cvH = seqImg.naturalHeight;
        } else if (contentImg && contentImg.complete && contentImg.naturalWidth > 0) {
            drawSource = contentImg;
            cvW = contentImg.naturalWidth;
            cvH = contentImg.naturalHeight;
        } else if (contentVideoEl && contentVideoEl.src && contentVideoEl.readyState >= 1 && contentVideoEl.videoWidth > 0) {
            drawSource = contentVideoEl;
            cvW = contentVideoEl.videoWidth;
            cvH = contentVideoEl.videoHeight;
        }

        if (drawSource && cvW > 0) {
            const { cropX, cropY, cropW, cropH } = _parseCropString(_selectedTask.contentVideoCrop);
            const sx = cvW * cropX;
            const sy = cvH * cropY;
            const sWidth = cvW * cropW;
            const sHeight = cvH * cropH;

            const cScale = (_selectedTask.contentVideoScale || 100) / 100;
            
            // Auto scale to fit width: width is 1080 -> canvas.width (w)
            const baseScale = w / sWidth;
            const finalScale = baseScale * cScale;
            
            const drawW = sWidth * finalScale;
            const drawH = sHeight * finalScale;
            
            // Default position: centered
            let drawX = (w - drawW) / 2;
            let drawY = (h - drawH) / 2;
            
            if (_selectedTask.contentVideoX && _selectedTask.contentVideoX !== 'center') {
                const relX = parseFloat(_selectedTask.contentVideoX);
                if (!isNaN(relX)) Math.abs(relX) <= 1 ? drawX += w * relX : drawX += (relX / 1080) * w;
            }
            if (_selectedTask.contentVideoY && _selectedTask.contentVideoY !== 'center') {
                const relY = parseFloat(_selectedTask.contentVideoY);
                if (!isNaN(relY)) Math.abs(relY) <= 1 ? drawY += h * relY : drawY += (relY / 1920) * h;
            }
            
            _drawImageFlipped(ctx, drawSource, sx, sy, sWidth, sHeight, drawX, drawY, drawW, drawH, _selectedTask.contentVideoFlipH, _selectedTask.contentVideoFlipV);
        }
    }

    // Calculate max overlay end time for cycle period
    let maxOverlayEnd = 0;
    if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        const overlays = _reelsState.overlayProxy.overlayMgr.overlays || [];
        for (const ov of overlays) {
            const end = parseFloat(ov.end || 0);
            if (end > maxOverlayEnd) maxOverlayEnd = end;
        }
    }

    let cycleTime = _getPreviewCurrentTime();
    // Subtract hook and cover duration so content time starts at 0 after hook ends
    const _hookDur = _reelsState.hookDuration || 0;
    const _coverDur = (_selectedTask && _selectedTask.cover && _selectedTask.cover.enabled) ? (parseFloat(_selectedTask.cover.duration) || 0.01) : 0;
    const _inHookPhase = _reelsState.hookPhase;
    const _inCoverPhase = _reelsState.coverPhase;
    
    if (!inCoverEditMode && (_hookDur > 0 || _coverDur > 0) && !_inHookPhase && !_inCoverPhase) {
        cycleTime = Math.max(0, cycleTime - _hookDur - _coverDur);
    }
    if (!(cycleTime > 0)) {
        // 检查是否有媒体正在播放
        const video = document.getElementById('reels-preview-video');
        const audio = document.getElementById('reels-preview-audio');
        const isMediaPlaying = _isPreviewMediaPlaying(video) || _isPreviewMediaPlaying(audio);

        if (isMediaPlaying) {
            // 媒体正在播放但 currentTime 尚为0，等下一帧
            cycleTime = 0;
        } else {
            // 没有媒体在播放 → 静止在 time=0 (不再自动循环)
            cycleTime = 0;
        }
    }

    const demoWords = previewText.split(/\s+/).filter(Boolean);
    const wordCount = demoWords.length || 1;
    const totalDur = Math.max(3, wordCount * 0.6);

    const wordsInfo = demoWords.map((w, i) => ({
        word: w,
        start: (totalDur * i / wordCount),
        end: (totalDur * (i + 1) / wordCount),
    }));

    const segment = {
        text: previewText,
        start: 0,
        end: totalDur,
        words: wordsInfo,
    };

    // If an actual task and segment exists, try to sync it.
    // For now, render exactly what the user inputs as a test segment if no timeline clip matches.
    // A more sophisticated system will find the correct segment based on video.currentTime
    let activeSegment = (_inHookPhase || _inCoverPhase) ? null : segment; // Hook 或 Cover 阶段不显示字母
    const taskForAudio = _getSelectedTask();
    const aDurScale = taskForAudio && taskForAudio.audioDurScale ? taskForAudio.audioDurScale / 100 : 1;
    const audioCycleTime = cycleTime / aDurScale;

    if (_reelsState.selectedIdx !== -1 && taskForAudio) {
        const segs = taskForAudio.segments || [];
        // Find segment
        const s = segs.find(s => audioCycleTime >= s.start && audioCycleTime <= s.end);
        if (s) {
            activeSegment = s;
        } else if ((style.scrolling_mode || style.fullpage_typewriter) && segs.length > 0) {
            // Scrolling/typewriter mode: find nearest segment so lines stay visible between gaps
            let best = segs[0];
            for (let i = 1; i < segs.length; i++) {
                if (segs[i].start <= audioCycleTime) best = segs[i];
                else break;
            }
            activeSegment = best;
        } else {
            // Not speaking, don't show test text
            activeSegment = null;
        }
    }

    const subtitleToggle = document.getElementById('reels-subtitle-toggle');
    const showSubtitle = !subtitleToggle || subtitleToggle.checked;
    const showOverlay = _isReelsOverlayToggleEnabled();
    const rangeToggle = document.getElementById('reels-show-subtitle-range');
    const showSubtitleRange = !rangeToggle || rangeToggle.checked;

    // 可按任务决定覆层与动态字幕的前后关系；默认保持旧项目的“覆层在上”。
    const overlayAboveSubtitle = taskForAudio?.overlayAboveSubtitle !== false;
    const renderOverlays = () => {
    // ── 渲染覆层 (文字卡片等) ──
    if (!inCoverEditMode && _inCoverPhase) {
        if (!showOverlay) return;
        // Normal mode > Cover phase -> ONLY render Cover overlays
        const coverOverlays = (_selectedTask && _selectedTask.cover && _selectedTask.cover.overlays) ? _selectedTask.cover.overlays : [];
        if (coverOverlays.length > 0 && window.ReelsOverlay) {
            for (const ov of coverOverlays) {
                if (ov.disabled) continue;
                ReelsOverlay.drawOverlay(ctx, ov, 0, w, h);
            }
        }
    } else if (!inCoverEditMode && _inHookPhase) {
        // Normal mode > Hook phase -> Do NOT render any overlays
    } else if (window.ReelsOverlay && _selectedTask) {
        // Cover edit mode OR Normal mode > Main Phase -> Render overlayMgr or task overlays + insertClips
        const ovMgr = _reelsState.overlayProxy ? _reelsState.overlayProxy.overlayMgr : null;
        // 使用与时间线、导出完全相同的合成栈。不能从 overlayMgr 和插入轨
        // 临时拼接后再按陈旧 z_index 排序，否则右侧/左侧的层级调整不会反映到画面。
        const overlays = _getTaskRenderOverlays(_selectedTask, { forExport: false, showOverlay });
        if (overlays.length > 0) {
            // 注入覆层列表引用（供跟随绑定），确保 scroll 先渲染
            const sorted = overlays.filter(o => !o.disabled).slice().sort((a, b) => {
                return (Number(a.z_index) || 0) - (Number(b.z_index) || 0);
            });
            for (const ov of sorted) {
                ov._allOverlays = overlays;
                // "显示终点" 模式：滚动字幕用终点时间渲染
                let ovTime = cycleTime;
                if (_reelsState._scrollPreviewEnd && ov.type === 'scroll') {
                    ovTime = parseFloat(ov.end || 10); // 用 end 时间，确保在时间范围内
                }
                
                ov._subtitleTimeMode = _selectedTask ? _selectedTask.subtitleTimeMode : null;
                ov._subtitleTimeSlices = _selectedTask ? _selectedTask.subtitleTimeSlices : null;
                if (ov.type === 'scroll') {
                    Object.defineProperty(ov, '_taskSegments', {
                        value: _selectedTask ? _selectedTask.segments : null,
                        writable: true,
                        configurable: true,
                        enumerable: false,
                    });
                }

                ReelsOverlay.drawOverlay(ctx, ov, ovTime, w, h);
            }
        }
        // ── 选中框 + 拖拽手柄 ──
        if (ovMgr && showOverlay) {
            _drawOverlaySelectionUI(ctx, w, h);
        }
    }
    };

    // 环境暗部与字幕光使用同一组样式，不能借用全局黑色遮罩。
    renderer.renderAmbientLightingBase?.(style, w, h);

    // “覆层在字幕下方”时先画覆层；否则等字幕完成后再画。
    if (!overlayAboveSubtitle) renderOverlays();

    // ── 渲染动态字幕 ──
    if (showSubtitleRange) {
        _drawSubtitlePreviewRange(ctx, style, w, h);
    }

    if (activeSegment && showSubtitle) {
        if (typeof _selectedTask !== 'undefined' && _selectedTask && _selectedTask.segments) {
            renderer.setContextSegments(_selectedTask.segments, _selectedTask.ttsText || _selectedTask.aiScript || '');
        } else {
            renderer.setContextSegments([activeSegment]);
        }
        renderer.renderSubtitle(style, activeSegment, audioCycleTime, w, h);
    }

    if (overlayAboveSubtitle) renderOverlays();

    // ── AI 水印 ──
    _drawWatermarks(ctx, w, h);

    // ── 更新时间显示 (覆层预览时间) ──
    const dDur = _getPreviewDuration();
    const cTime = _getPreviewCurrentTime();

    // 如果没有真实的媒体元素 或 mock时钟正在驱动(Cover/Hook阶段)，渲染循环必须主动驱动时间轴和 UI 的更新
    // 即使存在 master 元素，也需要在暂停/拖拽状态下更新时间显示（_updatePreviewTimeUI 内部有 scrubbing 保护）
    if (!_getPreviewMasterElement() || _reelsState.mockPlaying || _isPreviewSeekLocked() || !cTime) {
        _updatePreviewTimeUI(cTime, dDur);
    }

    // ── Hook → Main 自动切换 ──
    _syncHookPhaseTransition();

    // 检查是否到达终点以自动停止
    if (!_isPreviewLoopEnabled() && dDur > 0 && cTime >= dDur) {
        // Reached the end
        const video = document.getElementById('reels-preview-video');
        const audio = document.getElementById('reels-preview-audio');
        const fadeVideo = _reelsState.previewFadeVideo;
        const hookVideoStop = document.getElementById('reels-preview-hook-video');
        const btn = document.getElementById('reels-preview-play');
        
        // Only force pause if it wasn't already manually paused to avoid spamming
        const isPlaying = _isPreviewMediaPlaying(audio) || _isPreviewMediaPlaying(video) || _reelsState.mockPlaying || _isPreviewMediaPlaying(hookVideoStop);
        if (isPlaying) {
            if (audio) audio.pause();
            if (video) video.pause();
            if (fadeVideo) fadeVideo.pause();
            if (hookVideoStop) hookVideoStop.pause();
            if (_reelsState._bgmAudioEl) _reelsState._bgmAudioEl.pause();
            
            _reelsState.mockPlaying = false;
            _reelsState.mockPausedTime = dDur; // Ensure UI stays at the end
            if (btn) btn.textContent = '▶️';
            // 确保进度条刚好停在满格位置
            _updatePreviewTimeUI(dDur, dDur);
        }
    }

    if (_reelsState.previewRAF) cancelAnimationFrame(_reelsState.previewRAF);
    const panel = document.getElementById('batch-reels-panel');
    if (panel && (panel.classList.contains('active') || panel.style.display !== 'none')) {
        _reelsState.previewRAF = requestAnimationFrame(() => reelsUpdatePreview());
    }
}

function _isReelsOverlayToggleEnabled() {
    const v1Toggle = document.getElementById('reels-overlay-toggle');
    if (v1Toggle) return v1Toggle.checked !== false;
    const v2Toggle = document.querySelector('#reels-preview-v2-root [data-role="overlays"]');
    if (v2Toggle) return v2Toggle.checked !== false;
    return true;
}

function reelsOnSubtitleToggleChange(checkbox) {
    const v2Toggle = document.querySelector('#reels-preview-v2-root [data-role="subs"]');
    if (v2Toggle && checkbox && v2Toggle !== checkbox) {
        v2Toggle.checked = checkbox.checked;
    }
    reelsUpdatePreview();
    if (typeof window.ReelsPreviewV2?.render === 'function') window.ReelsPreviewV2.render();
    if (checkbox && !checkbox.checked) {
        const message = '已关闭字幕：预览不显示字幕，导出的视频也不会带字幕。';
        if (typeof showToast === 'function') showToast(message, 'warning');
        else alert(message);
    }
}
window.reelsOnSubtitleToggleChange = reelsOnSubtitleToggleChange;

function reelsOnOverlayToggleChange(checkbox) {
    const v1Toggle = document.getElementById('reels-overlay-toggle');
    if (v1Toggle && checkbox && v1Toggle !== checkbox) {
        v1Toggle.checked = checkbox.checked;
    }
    const v2Toggle = document.querySelector('#reels-preview-v2-root [data-role="overlays"]');
    if (v2Toggle && checkbox && v2Toggle !== checkbox) {
        v2Toggle.checked = checkbox.checked;
    }
    reelsUpdatePreview();
    if (typeof window.ReelsPreviewV2?.render === 'function') window.ReelsPreviewV2.render();
    if (checkbox && !checkbox.checked) {
        const message = '已关闭覆层：预览不显示覆层，导出的视频也不会带覆层。';
        if (typeof showToast === 'function') showToast(message, 'warning');
        else alert(message);
    }
}
window.reelsOnOverlayToggleChange = reelsOnOverlayToggleChange;

function _drawSubtitlePreviewRange(ctx, style, canvasW, canvasH) {
    if (!ctx || !style) return;
    ctx.save();
    ctx.setLineDash([10, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 224, 255, 0.9)';
    ctx.fillStyle = 'rgba(0, 224, 255, 0.08)';

    if ((!style.mixed_layout || style.mixed_layout === 'none') && style.anim_in_type === 'word_random_position' && style.random_position_use_layout_range !== false) {
        const cx = (typeof style.pos_x === 'number' && style.pos_x <= 1) ? style.pos_x * canvasW : (style.pos_x || canvasW / 2);
        const cy = (typeof style.pos_y === 'number' && style.pos_y <= 1) ? style.pos_y * canvasH : (style.pos_y || canvasH * 0.5);
        const rangeW = Math.max(20, Math.min(120, parseFloat(style.wrap_width_percent) || 70)) / 100 * canvasW;
        const rangeH = Math.max(10, Math.min(100, parseFloat(style.random_position_height_percent) || 35)) / 100 * canvasH;
        const x = cx - rangeW / 2;
        const y = cy - rangeH / 2;

        ctx.strokeStyle = 'rgba(255, 196, 64, 0.95)';
        ctx.fillStyle = 'rgba(255, 196, 64, 0.10)';
        ctx.strokeRect(x, y, rangeW, rangeH);
        ctx.fillRect(x, y, rangeW, rangeH);

        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 196, 64, 0.55)';
        ctx.beginPath();
        ctx.moveTo(cx, y);
        ctx.lineTo(cx, y + rangeH);
        ctx.moveTo(x, cy);
        ctx.lineTo(x + rangeW, cy);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255, 196, 64, 0.95)';
        ctx.font = '14px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(`随机区域 ${Math.round(style.wrap_width_percent || 70)}% x ${Math.round(style.random_position_height_percent || 35)}%`, x + 8, y + 8);
        ctx.restore();
        return;
    }

    if (style.advanced_textbox_enabled) {
        const x = parseFloat(style.advanced_textbox_x) || 0;
        const y = parseFloat(style.advanced_textbox_y) || 0;
        const w = Math.max(80, parseFloat(style.advanced_textbox_w) || canvasW * 0.8);
        const h = Math.max(40, parseFloat(style.advanced_textbox_h) || 200);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
        return;
    }

    const cx = (typeof style.pos_x === 'number' && style.pos_x <= 1) ? style.pos_x * canvasW : (style.pos_x || canvasW / 2);
    const cy = (typeof style.pos_y === 'number' && style.pos_y <= 1) ? style.pos_y * canvasH : (style.pos_y || canvasH * 0.5);
    const wrapPercent = Math.max(20, Math.min(120, parseFloat(style.wrap_width_percent) || 90));
    const textW = Math.max(200, Math.floor(canvasW * (wrapPercent / 100)));
    const fontSize = parseFloat(style.fontsize) || 74;
    const lineSpacing = parseFloat(style.line_spacing) || 0;
    const lines = Math.max(1, parseInt(style.wrap_lines, 10) || 2);
    const lineH = fontSize * 1.2;
    const textH = lineH * lines + lineSpacing * Math.max(0, lines - 1);
    const padX = parseFloat(style.box_padding_x) || 12;
    const padY = parseFloat(style.box_padding_y) || 8;

    const x = cx - textW / 2 - padX;
    const y = cy - textH / 2 - padY;
    const w = textW + padX * 2;
    const h = textH + padY * 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillRect(x, y, w, h);

    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 224, 255, 0.45)';
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx, y + h);
    ctx.stroke();
    ctx.restore();
}
// V2 preview uses the same guide calculation so the checkbox has identical
// behaviour in both preview engines.
window._drawSubtitlePreviewRange = _drawSubtitlePreviewRange;

const watermarkImageCache = new Map();

function _normalizeWatermarkPath(pathValue) {
    if (!pathValue) return '';
    if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
        try {
            const u = window.electronAPI.toFileUrl(pathValue);
            if (u) return u;
        } catch (e) {
            console.error('Failed to normalize watermark path with toFileUrl:', e);
        }
    }
    if (/^file:\/\//i.test(pathValue)) {
        return pathValue;
    }
    if (/^[a-zA-Z]:[/\\]/.test(pathValue)) {
        const replaced = pathValue.replace(/\\/g, '/');
        const parts = replaced.split('/');
        const drive = parts[0];
        const rest = parts.slice(1).map(encodeURIComponent).join('/');
        return `file:///${drive}/${rest}`;
    }
    if (pathValue.startsWith('/')) {
        return 'file://' + pathValue.split('/').map(p => p === '' ? '' : encodeURIComponent(p)).join('/');
    }
    return pathValue;
}

function _getWatermarkImage(pathValue, onLoadedCallback) {
    if (!pathValue) return null;
    const normalized = _normalizeWatermarkPath(pathValue);
    let entry = watermarkImageCache.get(normalized);
    if (!entry) {
        const img = new Image();
        entry = { img, status: 'loading', path: normalized };
        img.onload = () => {
            entry.status = 'loaded';
            if (onLoadedCallback) onLoadedCallback();
        };
        img.onerror = () => {
            entry.status = 'error';
            if (onLoadedCallback) onLoadedCallback();
        };
        img.src = normalized;
        watermarkImageCache.set(normalized, entry);
    }
    return entry;
}

/**
 * 绘制 AI 水印 (预览 + 导出共用)
 */
function _drawWatermarks(ctx, canvasW, canvasH) {
    const watermarks = _reelsState.watermarks || [];
    for (const wm of watermarks) {
        if (!wm.enabled) continue;

        if (wm.type === 'image') {
            if (!wm.imagePath) continue;
            const imgEntry = _getWatermarkImage(wm.imagePath, () => {
                if (typeof reelsUpdatePreview === 'function') {
                    reelsUpdatePreview();
                }
            });
            if (!imgEntry || imgEntry.status !== 'loaded' || !imgEntry.img) continue;

            const img = imgEntry.img;
            const imgW = img.naturalWidth || img.width;
            const imgH = img.naturalHeight || img.height;
            if (imgW <= 0 || imgH <= 0) continue;

            const scalePct = wm.imageScale || 100;
            const scaledW = imgW * (scalePct / 100);
            const scaledH = imgH * (scalePct / 100);

            // 计算位置参考点 px, py
            const margin = 16;
            let px, py;
            switch (wm.position || 'top-right') {
                case 'top-left': px = margin; py = margin; break;
                case 'top-center': px = canvasW / 2; py = margin; break;
                case 'top-right': px = canvasW - margin; py = margin; break;
                case 'center-left': px = margin; py = canvasH / 2; break;
                case 'center': px = canvasW / 2; py = canvasH / 2; break;
                case 'center-right': px = canvasW - margin; py = canvasH / 2; break;
                case 'bottom-left': px = margin; py = canvasH - margin; break;
                case 'bottom-center': px = canvasW / 2; py = canvasH - margin; break;
                case 'bottom-right': px = canvasW - margin; py = canvasH - margin; break;
                case 'custom': px = 0; py = 0; break;
                default: px = canvasW - margin; py = margin; break;
            }
            px += (wm.x || 0);
            py += (wm.y || 0);

            // 根据缩放中心（anchor）计算实际 drawX, drawY
            let drawX, drawY;
            const anchor = wm.imageAnchor || 'center';
            switch (anchor) {
                case 'top-left':
                    drawX = px; drawY = py;
                    break;
                case 'top-right':
                    drawX = px - scaledW; drawY = py;
                    break;
                case 'bottom-left':
                    drawX = px; drawY = py - scaledH;
                    break;
                case 'bottom-right':
                    drawX = px - scaledW; drawY = py - scaledH;
                    break;
                case 'center':
                default:
                    drawX = px - scaledW / 2; drawY = py - scaledH / 2;
                    break;
            }

            ctx.save();
            ctx.globalAlpha = wm.opacity ?? 1.0;
            _drawImageFlipped(ctx, img, drawX, drawY, scaledW, scaledH, undefined, undefined, undefined, undefined, wm.flipH, wm.flipV);
            ctx.restore();
        } else {
            if (!wm.text) continue;
            const fontSize = wm.fontSize || 20;
            const padH = Math.round(fontSize * 0.5);
            const padV = Math.round(fontSize * 0.35);

            ctx.save();
            ctx.font = `${fontSize}px Arial, sans-serif`;
            const lines = wm.text.split('\n');
            let maxTextW = 0;
            for (const line of lines) {
                maxTextW = Math.max(maxTextW, ctx.measureText(line).width);
            }
            const boxW = maxTextW + padH * 2;
            const lineSpacing = 4;
            const boxH = lines.length * fontSize + (lines.length - 1) * lineSpacing + padV * 2;

            // 计算位置
            const margin = 16;
            let bx, by;
            switch (wm.position || 'top-right') {
                case 'top-left': bx = margin; by = margin; break;
                case 'top-center': bx = (canvasW - boxW) / 2; by = margin; break;
                case 'top-right': bx = canvasW - boxW - margin; by = margin; break;
                case 'center-left': bx = margin; by = (canvasH - boxH) / 2; break;
                case 'center': bx = (canvasW - boxW) / 2; by = (canvasH - boxH) / 2; break;
                case 'center-right': bx = canvasW - boxW - margin; by = (canvasH - boxH) / 2; break;
                case 'bottom-left': bx = margin; by = canvasH - boxH - margin; break;
                case 'bottom-center': bx = (canvasW - boxW) / 2; by = canvasH - boxH - margin; break;
                case 'bottom-right': bx = canvasW - boxW - margin; by = canvasH - boxH - margin; break;
                case 'custom': bx = 0; by = 0; break;
                default: bx = canvasW - boxW - margin; by = margin; break;
            }
            bx += (wm.x || 0);
            by += (wm.y || 0);

            // 半透明背景
            ctx.globalAlpha = wm.bgOpacity ?? 0.5;
            ctx.fillStyle = wm.bgColor || '#000000';
            const r = Math.round(fontSize * 0.2);
            ctx.beginPath();
            ctx.roundRect(bx, by, boxW, boxH, r);
            ctx.fill();

            // 文字
            ctx.globalAlpha = wm.textOpacity ?? 1.0;
            ctx.fillStyle = wm.color || '#FFFFFF';
            ctx.textBaseline = 'middle';
            let currentY = by + padV + fontSize / 2;
            for (const line of lines) {
                ctx.fillText(line, bx + padH, currentY);
                currentY += fontSize + lineSpacing;
            }
            ctx.restore();
        }
    }
}

const REELS_DEFAULT_WATERMARK = [
    {
        type: 'text',
        text: 'AI Generated', fontSize: 25, color: '#FFFFFF', textOpacity: 0.8,
        bgColor: '#000000', bgOpacity: 0.5, position: 'top-right', enabled: true
    },
    {
        type: 'text',
        text: 'Attribution to11.ai', fontSize: 20, color: '#FFFFFF', textOpacity: 1.0,
        bgColor: '#000000', bgOpacity: 0.5, position: 'bottom-left', enabled: true
    },
    {
        type: 'image',
        imagePath: (window.electronAPI && window.electronAPI.resolveAssetUrl)
            ? window.electronAPI.resolveAssetUrl('colossyan.png')
            : 'assets/colossyan.png',
        imageScale: 100,
        imageAnchor: 'center',
        opacity: 1.0,
        position: 'center',
        enabled: false
    }
];

function _reelsSaveWatermarks() {
    try {
        localStorage.setItem(REELS_WATERMARK_STORAGE_KEY, JSON.stringify(_reelsState.watermarks));
    } catch (e) { /* quota exceeded etc */ }
}

function _reelsLoadWatermarks() {
    try {
        const saved = localStorage.getItem(REELS_WATERMARK_STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                _reelsState.watermarks = parsed;
                // 确保用户已保存的列表中也包含新的 colossyan 默认预设
                const hasColossyan = parsed.some(wm => wm.type === 'image' && wm.imagePath && wm.imagePath.includes('colossyan.png'));
                if (!hasColossyan) {
                    _reelsState.watermarks.push({
                        type: 'image',
                        imagePath: (window.electronAPI && window.electronAPI.resolveAssetUrl)
                            ? window.electronAPI.resolveAssetUrl('colossyan.png')
                            : 'assets/colossyan.png',
                        imageScale: 100,
                        imageAnchor: 'center',
                        opacity: 1.0,
                        position: 'center',
                        enabled: false
                    });
                    _reelsSaveWatermarks();
                }
                return;
            }
        }
    } catch (e) { /* parse error */ }
    // No saved data — use default
    _reelsState.watermarks = JSON.parse(JSON.stringify(REELS_DEFAULT_WATERMARK));
}

function reelsAddWatermark() {
    _reelsState.watermarks.push({
        type: 'text',
        text: 'Attribution to11.ai', fontSize: 20, color: '#FFFFFF', textOpacity: 1.0,
        bgColor: '#000000', bgOpacity: 0.5, position: 'bottom-left', enabled: true,
    });
    _reelsRefreshWatermarkUI();
    _reelsSaveWatermarks();
}

function reelsRemoveWatermark(idx) {
    _reelsState.watermarks.splice(idx, 1);
    _reelsRefreshWatermarkUI();
    _reelsSaveWatermarks();
}

const REELS_WATERMARK_PRESETS_KEY = 'reels_watermark_presets';

function _getWatermarkPresets() {
    try {
        return JSON.parse(localStorage.getItem(REELS_WATERMARK_PRESETS_KEY)) || {};
    } catch {
        return {};
    }
}

function _saveWatermarkPresets(presets) {
    localStorage.setItem(REELS_WATERMARK_PRESETS_KEY, JSON.stringify(presets));
}

function _refreshWatermarkPresetList() {
    const select = document.getElementById('reels-watermark-preset-select');
    if (!select) return;
    const presets = _getWatermarkPresets();
    const currVal = select.value;
    select.innerHTML = '<option value="">-- 选择预设 --</option>';
    for (const name in presets) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }
    if (presets[currVal]) {
        select.value = currVal;
    }
}

async function reelsSaveWatermarkPreset() {
    if (!_reelsState.watermarks || _reelsState.watermarks.length === 0) {
        alert('当前没有水印，无法保存预设');
        return;
    }
    try {
        const name = await _showInputDialog('保存水印组合预设', '请输入预设名称（包含所有启用的水印）');
        if (!name) return;
        const presets = _getWatermarkPresets();
        if (presets[name]) {
            const ok = confirm(`水印预设 "${name}" 已存在，是否覆盖？`);
            if (!ok) return;
        }
        presets[name] = JSON.parse(JSON.stringify(_reelsState.watermarks));
        _saveWatermarkPresets(presets);
        _refreshWatermarkPresetList();
        const select = document.getElementById('reels-watermark-preset-select');
        if (select) select.value = name;
    } catch (e) {
        console.error('Save watermark preset error:', e);
    }
}

function reelsLoadWatermarkPreset() {
    const select = document.getElementById('reels-watermark-preset-select');
    if (!select) return;
    const name = select.value;
    if (!name) return;
    const presets = _getWatermarkPresets();
    if (presets[name]) {
        _reelsState.watermarks = JSON.parse(JSON.stringify(presets[name]));
        localStorage.setItem(REELS_WATERMARK_STORAGE_KEY, JSON.stringify(_reelsState.watermarks));
        _reelsRefreshWatermarkUI();
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    }
}

function reelsDeleteWatermarkPreset() {
    const select = document.getElementById('reels-watermark-preset-select');
    if (!select) return;
    const name = select.value;
    if (!name) {
        alert('请先选择要删除的预设');
        return;
    }
    if (confirm(`确定要删除水印预设 "${name}" 吗？`)) {
        const presets = _getWatermarkPresets();
        delete presets[name];
        _saveWatermarkPresets(presets);
        _refreshWatermarkPresetList();
        select.value = '';
    }
}

function reelsExportWatermarkPresets() {
    const presets = _getWatermarkPresets();
    if (Object.keys(presets).length === 0) {
        alert('没有可以导出的水印预设！');
        return;
    }
    const jsonStr = JSON.stringify(presets, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `watermark_presets_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function reelsImportWatermarkPresets() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const imported = JSON.parse(ev.target.result);
                if (typeof imported !== 'object' || imported === null) throw new Error('Invalid JSON');
                const presets = _getWatermarkPresets();
                let addedCount = 0;
                let overwrittenCount = 0;
                const conflicts = [];
                for (const k in imported) {
                    if (Array.isArray(imported[k]) && presets[k]) {
                        conflicts.push(k);
                    }
                }

                if (conflicts.length > 0) {
                    const ok = confirm(`导入的水印预设中包含以下已存在的预设：\n${conflicts.join(', ')}\n\n是否覆盖它们？(点击「取消」将跳过这些冲突的预设)`);
                    for (const k in imported) {
                        if (Array.isArray(imported[k])) {
                            if (presets[k]) {
                                if (ok) {
                                    presets[k] = imported[k];
                                    overwrittenCount++;
                                }
                            } else {
                                presets[k] = imported[k];
                                addedCount++;
                            }
                        }
                    }
                } else {
                    for (const k in imported) {
                        if (Array.isArray(imported[k])) {
                            presets[k] = imported[k];
                            addedCount++;
                        }
                    }
                }

                _saveWatermarkPresets(presets);
                _refreshWatermarkPresetList();
                alert(`✅ 导入完成：新增了 ${addedCount} 个水印预设，覆盖了 ${overwrittenCount} 个水印预设。`);
            } catch (err) {
                alert('导入失败，请检查是否是有效的水印预设 JSON 文件！');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

async function reelsChooseWatermarkImage(idx) {
    const path = await _pickSingleFile('选择水印图片', ['png', 'jpg', 'jpeg', 'webp', 'gif']);
    if (path) {
        if (_reelsState.watermarks && _reelsState.watermarks[idx]) {
            _reelsState.watermarks[idx].imagePath = path;
            _reelsRefreshWatermarkUI();
            _reelsSyncWatermarkFromUI();
        }
    }
}

function _reelsSyncWatermarkFromUI() {
    const list = document.getElementById('reels-watermark-list');
    if (!list) return;
    const rows = list.querySelectorAll('.wm-row');
    rows.forEach((row, i) => {
        const wm = _reelsState.watermarks[i];
        if (!wm) return;
        wm.enabled = row.querySelector('.wm-enabled')?.checked ?? true;
        wm.type = row.querySelector('.wm-type')?.value || 'text';
        wm.position = row.querySelector('.wm-position')?.value || 'top-right';
        wm.x = parseInt(row.querySelector('.wm-x')?.value) || 0;
        wm.y = parseInt(row.querySelector('.wm-y')?.value) || 0;

        if (wm.type === 'image') {
            wm.imagePath = row.querySelector('.wm-imagepath')?.value || '';
            wm.imageScale = parseInt(row.querySelector('.wm-imagescale')?.value) || 100;
            wm.imageAnchor = row.querySelector('.wm-imageanchor')?.value || 'center';
            const rawOp = parseFloat(row.querySelector('.wm-opacity')?.value);
            wm.opacity = Number.isFinite(rawOp) ? rawOp / 100 : 1.0;
            wm.flipH = row.querySelector('.wm-fliph')?.checked ?? false;
            wm.flipV = row.querySelector('.wm-flipv')?.checked ?? false;
        } else {
            wm.text = row.querySelector('.wm-text')?.value || '';
            wm.fontSize = parseInt(row.querySelector('.wm-fontsize')?.value) || 20;
            wm.color = row.querySelector('.wm-color')?.value || '#FFFFFF';
            wm.bgColor = row.querySelector('.wm-bgcolor')?.value || '#000000';
            const rawBgOp = parseFloat(row.querySelector('.wm-bgopacity')?.value);
            wm.bgOpacity = Number.isFinite(rawBgOp) ? rawBgOp / 100 : 0.5;
            const rawTextOp = parseFloat(row.querySelector('.wm-textopacity')?.value);
            wm.textOpacity = Number.isFinite(rawTextOp) ? rawTextOp / 100 : 1.0;
        }
    });
    _reelsSaveWatermarks();
    if (typeof reelsUpdatePreview === 'function') {
        reelsUpdatePreview();
    }
}

function _reelsRefreshWatermarkUI() {
    const list = document.getElementById('reels-watermark-list');
    const countEl = document.getElementById('reels-wm-count');
    if (!list) return;
    const wms = _reelsState.watermarks;
    if (countEl) countEl.textContent = `${wms.length} 个`;
    const posOptions = [
        ['top-left', '左上'], ['top-center', '上中'], ['top-right', '右上'],
        ['center-left', '左中'], ['center', '居中'], ['center-right', '右中'],
        ['bottom-left', '左下'], ['bottom-center', '下中'], ['bottom-right', '右下'],
        ['custom', '自定义坐标']
    ].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

    list.innerHTML = wms.map((wm, i) => {
        const isImage = wm.type === 'image';
        const typeSelectHtml = `
            <select class="wm-type select" style="width:65px;font-size:11px;padding:2px;" onchange="_reelsSyncWatermarkFromUI(); _reelsRefreshWatermarkUI();">
                <option value="text" ${!isImage ? 'selected' : ''}>文字</option>
                <option value="image" ${isImage ? 'selected' : ''}>图片</option>
            </select>
        `;

        let contentHtml = '';
        let optionsHtml = '';

        if (isImage) {
            contentHtml = `
                <div style="display:flex;align-items:center;gap:4px;flex:1;">
                    <input type="text" class="wm-imagepath input" readonly value="${wm.imagePath || ''}" style="flex:1;font-size:11px;padding:4px 6px;" placeholder="未选择图片">
                    <button class="btn btn-secondary" style="font-size:11px;padding:2px 6px;" onclick="reelsChooseWatermarkImage(${i})">选择</button>
                </div>
            `;
            optionsHtml = `
                 <label style="display:flex;align-items:center;gap:2px;">缩放中心:
                    <select class="wm-imageanchor select" style="width:75px;font-size:11px;padding:3px;" onchange="_reelsSyncWatermarkFromUI()">
                        <option value="top-left" ${wm.imageAnchor === 'top-left' ? 'selected' : ''}>左上</option>
                        <option value="top-right" ${wm.imageAnchor === 'top-right' ? 'selected' : ''}>右上</option>
                        <option value="bottom-left" ${wm.imageAnchor === 'bottom-left' ? 'selected' : ''}>左下</option>
                        <option value="bottom-right" ${wm.imageAnchor === 'bottom-right' ? 'selected' : ''}>右下</option>
                        <option value="center" ${wm.imageAnchor === 'center' || !wm.imageAnchor ? 'selected' : ''}>居中</option>
                    </select>
                </label>
                <label style="display:flex;align-items:center;gap:2px;">缩放:<input type="range" class="wm-imagescale-slider" min="10" max="500" value="${wm.imageScale || 100}" style="width:50px;height:14px;accent-color:#4fc3f7;vertical-align:middle;" oninput="this.parentElement.querySelector('.wm-imagescale').value=this.value;_reelsSyncWatermarkFromUI()"><input class="wm-imagescale input input-small" type="number" value="${wm.imageScale || 100}" min="10" max="500" style="width:38px;font-size:10px;padding:2px;text-align:center;" oninput="this.parentElement.querySelector('.wm-imagescale-slider').value=this.value;_reelsSyncWatermarkFromUI()">%</label>
                <label style="display:flex;align-items:center;gap:2px;">透明:<input type="range" class="wm-opacity-slider" min="0" max="100" value="${Math.round((wm.opacity ?? 1.0) * 100)}" style="width:50px;height:14px;accent-color:#9b59b6;vertical-align:middle;" oninput="this.parentElement.querySelector('.wm-opacity').value=this.value;_reelsSyncWatermarkFromUI()"><input class="wm-opacity input input-small" type="number" value="${Math.round((wm.opacity ?? 1.0) * 100)}" min="0" max="100" style="width:38px;font-size:10px;padding:2px;text-align:center;" oninput="this.parentElement.querySelector('.wm-opacity-slider').value=this.value;_reelsSyncWatermarkFromUI()">%</label>
                <label style="display:flex;align-items:center;gap:3px;cursor:pointer;"><input type="checkbox" class="wm-fliph" ${wm.flipH ? 'checked' : ''} onchange="_reelsSyncWatermarkFromUI()"> 左右翻转</label>
                <label style="display:flex;align-items:center;gap:3px;cursor:pointer;"><input type="checkbox" class="wm-flipv" ${wm.flipV ? 'checked' : ''} onchange="_reelsSyncWatermarkFromUI()"> 上下翻转</label>
            `;
        } else {
            contentHtml = `
                <textarea class="wm-text input" style="flex:1;font-size:11px;padding:4px 6px;resize:vertical;min-height:28px;" rows="1" oninput="_reelsSyncWatermarkFromUI()">${(wm.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
            `;
            optionsHtml = `
                <label style="display:flex;align-items:center;gap:2px;">字号:<input class="wm-fontsize input input-small" type="number" value="${wm.fontSize || 20}" min="8" max="80" style="width:48px;font-size:11px;padding:3px;" oninput="_reelsSyncWatermarkFromUI()"></label>
                <label style="display:flex;align-items:center;gap:2px;">字色:<input class="wm-color" type="color" value="${wm.color || '#FFFFFF'}" style="width:24px;height:20px;border:none;cursor:pointer;" oninput="_reelsSyncWatermarkFromUI()"></label>
                <label style="display:flex;align-items:center;gap:2px;">字透明:<input type="range" class="wm-textopacity-slider" min="0" max="100" value="${Math.round((wm.textOpacity ?? 1.0) * 100)}" style="width:50px;height:14px;accent-color:#4fc3f7;vertical-align:middle;" oninput="this.parentElement.querySelector('.wm-textopacity').value=this.value;_reelsSyncWatermarkFromUI()"><input class="wm-textopacity input input-small" type="number" value="${Math.round((wm.textOpacity ?? 1.0) * 100)}" min="0" max="100" style="width:38px;font-size:10px;padding:2px;text-align:center;" oninput="this.parentElement.querySelector('.wm-textopacity-slider').value=this.value;_reelsSyncWatermarkFromUI()">%</label>
                <label style="display:flex;align-items:center;gap:2px;">底色:<input class="wm-bgcolor" type="color" value="${wm.bgColor || '#000000'}" style="width:24px;height:20px;border:none;cursor:pointer;" oninput="_reelsSyncWatermarkFromUI()"></label>
                <label style="display:flex;align-items:center;gap:2px;">底透明:<input type="range" class="wm-bgopacity-slider" min="0" max="100" value="${Math.round((wm.bgOpacity ?? 0.5) * 100)}" style="width:50px;height:14px;accent-color:#9b59b6;vertical-align:middle;" oninput="this.parentElement.querySelector('.wm-bgopacity').value=this.value;_reelsSyncWatermarkFromUI()"><input class="wm-bgopacity input input-small" type="number" value="${Math.round((wm.bgOpacity ?? 0.5) * 100)}" min="0" max="100" style="width:38px;font-size:10px;padding:2px;text-align:center;" oninput="this.parentElement.querySelector('.wm-bgopacity-slider').value=this.value;_reelsSyncWatermarkFromUI()">%</label>
            `;
        }

        return `
            <div class="wm-row" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;padding:6px;background:var(--bg-tertiary);border-radius:6px;">
                <div style="display:flex;gap:6px;width:100%;align-items:flex-start;">
                    <label style="display:flex;align-items:center;gap:3px;margin-top:4px;"><input type="checkbox" class="wm-enabled" ${wm.enabled ? 'checked' : ''} onchange="_reelsSyncWatermarkFromUI()"> 启用</label>
                    <label style="display:flex;align-items:center;gap:3px;margin-top:4px;">类型: ${typeSelectHtml}</label>
                    ${contentHtml}
                    <button class="btn btn-secondary" style="font-size:10px;padding:2px 6px;color:#f87171;margin-top:4px;" onclick="reelsRemoveWatermark(${i})">✕</button>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;">
                    ${optionsHtml}
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;">
                    <label style="display:flex;align-items:center;gap:4px;">位置: <select class="wm-position select" style="width:85px;font-size:11px;padding:3px;" onchange="_reelsSyncWatermarkFromUI()">${posOptions.replace(`value="${wm.position || 'top-right'}"`, `value="${wm.position || 'top-right'}" selected`)}</select></label>
                    <label style="display:flex;align-items:center;gap:2px;margin-left:4px;" title="偏移值（可填负数）">偏移X:<input class="wm-x input input-small" type="number" value="${wm.x || 0}" style="width:48px;font-size:11px;padding:3px;" oninput="_reelsSyncWatermarkFromUI()"></label>
                    <label style="display:flex;align-items:center;gap:2px;">Y:<input class="wm-y input input-small" type="number" value="${wm.y || 0}" style="width:48px;font-size:11px;padding:3px;" oninput="_reelsSyncWatermarkFromUI()"></label>
                </div>
            </div>
        `;
    }).join('');

    // 添加鼠标左右拖拽调整数值功能
    list.querySelectorAll('input[type="number"]').forEach(el => {
        el.style.cursor = 'ew-resize';
        let dragging = false, startX = 0, startVal = 0;
        el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (document.activeElement === el) return;
            dragging = true;
            startX = e.clientX;
            startVal = parseFloat(el.value) || 0;
            e.preventDefault();
            const onMove = (me) => {
                if (!dragging) return;
                const dx = me.clientX - startX;
                const speed = me.shiftKey ? 0.1 : 1;
                const step = parseFloat(el.getAttribute('step')) || 1;
                let newVal = Math.round((startVal + dx * speed * step) / step) * step;
                
                // 处理极值
                const min = parseFloat(el.getAttribute('min'));
                const max = parseFloat(el.getAttribute('max'));
                if (!isNaN(min) && newVal < min) newVal = min;
                if (!isNaN(max) && newVal > max) newVal = max;

                el.value = newVal;
                // 触发同步和预览刷新（通过 dispatchEvent 触发 inline oninput）
                el.dispatchEvent(new Event('input'));
            };
            const onUp = () => {
                dragging = false;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        el.addEventListener('dblclick', (e) => {
            e.preventDefault();
            el.focus();
            el.select();
        });
    });
}

// 初始化水印 — 从 localStorage 恢复
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        _reelsLoadWatermarks();
        _reelsRefreshWatermarkUI();
        _refreshWatermarkPresetList();
        _initAllSubtitleNumberInputsDrag();
        _initSubtitleGradientPickers();
    }, 500);
});

function _syncSubtitleGradientSwatch(colorEl, btn) {
    if (!colorEl) return;
    const gradVal = colorEl.dataset?.gradientValue;
    const direction = colorEl.dataset?.gradientDirection || 'horizontal';

    // 1. Locate wrapper or parent
    let wrap = null;
    try {
        if (typeof colorEl.closest === 'function') {
            wrap = colorEl.closest('.vk-color-picker-wrap');
        }
    } catch (_) {}
    if (!wrap && colorEl.parentElement) {
        wrap = colorEl.parentElement;
    }
    if (wrap && typeof window !== 'undefined' && window.getComputedStyle) {
        try {
            if (getComputedStyle(wrap).position === 'static') {
                wrap.style.position = 'relative';
            }
        } catch (_) {}
    }

    // 2. Locate or create overlay preview badge
    let overlay = null;
    try {
        if (wrap && typeof wrap.querySelector === 'function') {
            overlay = wrap.querySelector(':scope > .vk-gradient-swatch-badge') || wrap.querySelector('.vk-gradient-swatch-badge');
        }
    } catch (_) {}

    if (!overlay && wrap && typeof document !== 'undefined' && typeof document.createElement === 'function') {
        try {
            overlay = document.createElement('div');
            overlay.className = 'vk-gradient-swatch-badge';
            overlay.style.display = 'none';
            if (typeof overlay.addEventListener === 'function') {
                overlay.addEventListener('click', (e) => {
                    if (e && typeof e.preventDefault === 'function') e.preventDefault();
                    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                    if (btn && typeof btn.click === 'function') btn.click();
                });
            }
            if (typeof wrap.insertBefore === 'function') {
                wrap.insertBefore(overlay, colorEl.nextSibling);
            } else if (typeof wrap.appendChild === 'function') {
                wrap.appendChild(overlay);
            }
        } catch (_) {}
    }

    if (gradVal && gradVal.includes(',')) {
        const colors = gradVal.split(',').map(c => c.trim()).filter(Boolean);
        const dirAngle = direction === 'horizontal' ? 'to right' : (direction === 'diagonal' ? '135deg' : 'to bottom');
        const dirLabel = direction === 'horizontal' ? '水平渐变' : (direction === 'diagonal' ? '对角渐变' : '垂直渐变');
        const gradCss = `linear-gradient(${dirAngle}, ${colors.join(', ')})`;

        // 3. Update overlay swatch
        if (overlay && overlay.style) {
            overlay.style.display = 'block';
            overlay.style.background = gradCss;
            overlay.title = `已启用${dirLabel} (${colors.length}色: ${colors.join(' → ')})\n点击编辑渐变色`;
            const w = colorEl.offsetWidth || 36;
            const h = colorEl.offsetHeight || 28;
            overlay.style.width = w + 'px';
            overlay.style.height = h + 'px';
            overlay.style.left = (colorEl.offsetLeft || 0) + 'px';
            overlay.style.top = (colorEl.offsetTop || 0) + 'px';
        }

        // Webkit swatch fallback
        if (colorEl.classList && typeof colorEl.classList.add === 'function') {
            colorEl.classList.add('vk-has-gradient');
        }
        if (colorEl.style && typeof colorEl.style.setProperty === 'function') {
            colorEl.style.setProperty('--vk-gradient-preview', gradCss);
        }

        // 4. Update button badge
        if (btn) {
            if (btn.classList && typeof btn.classList.add === 'function') {
                btn.classList.add('vk-gradient-btn-active');
            }
            btn.innerHTML = `🌈 <span class="vk-grad-direction-tag" style="font-size:11px; font-weight:600;">${dirLabel}</span><span class="vk-grad-clear-btn" title="取消渐变，恢复为纯色">×</span>`;
            btn.title = `已启用${dirLabel} (${colors.length}色: ${colors.join(' → ')})\n点击编辑渐变，点击 × 恢复纯色`;

            const clearBtn = typeof btn.querySelector === 'function' ? btn.querySelector('.vk-grad-clear-btn') : null;
            if (clearBtn && typeof clearBtn.addEventListener === 'function') {
                clearBtn.addEventListener('click', (e) => {
                    if (e && typeof e.preventDefault === 'function') e.preventDefault();
                    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                    if (colorEl.dataset) delete colorEl.dataset.gradientValue;
                    _syncSubtitleGradientSwatch(colorEl, btn);
                    if (typeof colorEl.dispatchEvent === 'function') {
                        colorEl.dispatchEvent(new Event('input', { bubbles: true }));
                        colorEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (typeof _persistSubtitleStyleByScope === 'function') {
                        _persistSubtitleStyleByScope(_readStyleFromUI());
                    }
                    if (typeof window !== 'undefined' && typeof window.reelsSaveHistory === 'function') {
                        window.reelsSaveHistory();
                    }
                    if (typeof window !== 'undefined' && typeof window.reelsUpdatePreview === 'function') {
                        window.reelsUpdatePreview();
                    }
                });
            }
        }
    } else {
        // Solid color mode
        if (overlay && overlay.style) {
            overlay.style.display = 'none';
        }
        if (colorEl.classList && typeof colorEl.classList.remove === 'function') {
            colorEl.classList.remove('vk-has-gradient');
        }
        if (colorEl.style && typeof colorEl.style.removeProperty === 'function') {
            colorEl.style.removeProperty('--vk-gradient-preview');
        }

        if (btn) {
            if (btn.classList && typeof btn.classList.remove === 'function') {
                btn.classList.remove('vk-gradient-btn-active');
            }
            btn.innerHTML = '🌈';
            btn.title = (btn.id && btn.id.includes('high')) ? '高亮渐变色 (支持多节点自定义)' : '文字渐变色 (支持多节点自定义)';
        }
    }
}

function _initSubtitleGradientPickers() {
    const btnText = document.getElementById('reels-color-text-gradient-btn');
    const colorTextEl = document.getElementById('reels-color-text');
    if (btnText && colorTextEl && !btnText.dataset.bound) {
        btnText.dataset.bound = '1';

        if (!colorTextEl._gradClickBound) {
            colorTextEl._gradClickBound = true;
            colorTextEl.addEventListener('click', (e) => {
                if (colorTextEl.dataset.gradientValue && colorTextEl.dataset.gradientValue.includes(',')) {
                    e.preventDefault();
                    e.stopPropagation();
                    btnText.click();
                }
            });
        }

        colorTextEl.addEventListener('input', (e) => {
            if (e.isTrusted && !colorTextEl._settingFromGradient) {
                delete colorTextEl.dataset.gradientValue;
                _syncSubtitleGradientSwatch(colorTextEl, btnText);
            }
        });

        btnText.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!window.ReelsGradientPicker) return;
            const currentVal = colorTextEl.dataset.gradientValue || colorTextEl.value || '#FFFFFF';
            const curDir = colorTextEl.dataset.gradientDirection || 'horizontal';
            window.ReelsGradientPicker.open({
                title: '字幕文字渐变色',
                value: currentVal,
                direction: curDir,
                anchorEl: btnText,
                onChange: ({ value, direction }) => {
                    colorTextEl._settingFromGradient = true;
                    try {
                        if (value.includes(',')) {
                            colorTextEl.dataset.gradientValue = value;
                            colorTextEl.value = value.split(',')[0].trim();
                        } else {
                            delete colorTextEl.dataset.gradientValue;
                            colorTextEl.value = value;
                        }
                        colorTextEl.dataset.gradientDirection = direction;

                        const ambient = document.getElementById('reels-ambient-text-color');
                        if (ambient) ambient.value = colorTextEl.value;

                        _syncSubtitleGradientSwatch(colorTextEl, btnText);

                        // 1. 立即持久化字幕样式到当前任务/全局
                        if (typeof _persistSubtitleStyleByScope === 'function') {
                            _persistSubtitleStyleByScope(_readStyleFromUI());
                        }

                        // 2. 触发 input 事件通知样式修改并解除预设锁定
                        colorTextEl.dispatchEvent(new Event('input', { bubbles: true }));

                        // 3. 记录历史操作
                        if (typeof window.reelsSaveHistory === 'function') {
                            window.reelsSaveHistory();
                        }

                        // 4. 实时刷新预览
                        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                    } finally {
                        colorTextEl._settingFromGradient = false;
                    }
                }
            });
        });

        _syncSubtitleGradientSwatch(colorTextEl, btnText);
    }

    const btnHigh = document.getElementById('reels-color-high-gradient-btn');
    const colorHighEl = document.getElementById('reels-color-high');
    if (btnHigh && colorHighEl && !btnHigh.dataset.bound) {
        btnHigh.dataset.bound = '1';

        if (!colorHighEl._gradClickBound) {
            colorHighEl._gradClickBound = true;
            colorHighEl.addEventListener('click', (e) => {
                if (colorHighEl.dataset.gradientValue && colorHighEl.dataset.gradientValue.includes(',')) {
                    e.preventDefault();
                    e.stopPropagation();
                    btnHigh.click();
                }
            });
        }

        colorHighEl.addEventListener('input', (e) => {
            if (e.isTrusted && !colorHighEl._settingFromGradient) {
                delete colorHighEl.dataset.gradientValue;
                _syncSubtitleGradientSwatch(colorHighEl, btnHigh);
            }
        });

        btnHigh.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!window.ReelsGradientPicker) return;
            const currentVal = colorHighEl.dataset.gradientValue || colorHighEl.value || '#FFD700';
            const curDir = colorHighEl.dataset.gradientDirection || 'horizontal';
            window.ReelsGradientPicker.open({
                title: '高亮文字渐变色',
                value: currentVal,
                direction: curDir,
                anchorEl: btnHigh,
                onChange: ({ value, direction }) => {
                    colorHighEl._settingFromGradient = true;
                    try {
                        if (value.includes(',')) {
                            colorHighEl.dataset.gradientValue = value;
                            colorHighEl.value = value.split(',')[0].trim();
                        } else {
                            delete colorHighEl.dataset.gradientValue;
                            colorHighEl.value = value;
                        }
                        colorHighEl.dataset.gradientDirection = direction;

                        _syncSubtitleGradientSwatch(colorHighEl, btnHigh);

                        // 1. 立即持久化字幕样式到当前任务/全局
                        if (typeof _persistSubtitleStyleByScope === 'function') {
                            _persistSubtitleStyleByScope(_readStyleFromUI());
                        }

                        // 2. 触发 input 事件通知样式修改并解除预设锁定
                        colorHighEl.dispatchEvent(new Event('input', { bubbles: true }));

                        // 3. 记录历史操作
                        if (typeof window.reelsSaveHistory === 'function') {
                            window.reelsSaveHistory();
                        }

                        // 4. 实时刷新预览
                        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                    } finally {
                        colorHighEl._settingFromGradient = false;
                    }
                }
            });
        });

        _syncSubtitleGradientSwatch(colorHighEl, btnHigh);
    }
}

function _initAllSubtitleNumberInputsDrag() {
    const container = document.getElementById('inspector-tab-subtitle');
    if (!container) return;
    
    container.querySelectorAll('input[type="number"]').forEach(el => {
        if (el.dataset.dragBound === '1') return;
        el.dataset.dragBound = '1';
        
        el.style.cursor = 'ew-resize';
        let dragging = false, startX = 0, startVal = 0;
        
        el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (document.activeElement === el) return;
            
            dragging = true;
            startX = e.clientX;
            startVal = parseFloat(el.value) || 0;
            e.preventDefault();
            
            const onMove = (me) => {
                if (!dragging) return;
                const dx = me.clientX - startX;
                const speed = me.shiftKey ? 0.1 : 1;
                const step = parseFloat(el.getAttribute('step')) || 1;
                let newVal = Math.round((startVal + dx * speed * step) / step) * step;
                
                const min = parseFloat(el.getAttribute('min'));
                const max = parseFloat(el.getAttribute('max'));
                if (!isNaN(min) && newVal < min) newVal = min;
                if (!isNaN(max) && newVal > max) newVal = max;
                
                el.value = newVal;
                
                const rangeEl = document.getElementById(el.id + '-range');
                if (rangeEl) rangeEl.value = newVal;
                
                el.dispatchEvent(new Event('input'));
            };
            
            const onUp = () => {
                dragging = false;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        
        el.addEventListener('dblclick', (e) => {
            e.preventDefault();
            el.focus();
            el.select();
        });
    });
}

function _drawImageFlipped(ctx, img, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, flipH, flipV, rotation = 0) {
    if (!flipH && !flipV && !rotation) {
        if (arg5 !== undefined) {
            ctx.drawImage(img, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
        } else if (arg3 !== undefined) {
            ctx.drawImage(img, arg1, arg2, arg3, arg4);
        } else {
            ctx.drawImage(img, arg1, arg2);
        }
        return;
    }
    
    ctx.save();
    let dx, dy, dw, dh;
    if (arg5 !== undefined) {
        // 9 arguments: img, sx, sy, sw, sh, dx, dy, dw, dh
        dx = arg5; dy = arg6; dw = arg7; dh = arg8;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        if (rotation) ctx.rotate(Number(rotation) * Math.PI / 180);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, arg1, arg2, arg3, arg4, -dw / 2, -dh / 2, dw, dh);
    } else if (arg3 !== undefined) {
        // 5 arguments: img, dx, dy, dw, dh
        dx = arg1; dy = arg2; dw = arg3; dh = arg4;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        if (rotation) ctx.rotate(Number(rotation) * Math.PI / 180);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    } else {
        // 3 arguments: img, dx, dy
        dx = arg1; dy = arg2; dw = img.naturalWidth || img.width || 0; dh = img.naturalHeight || img.height || 0;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        if (rotation) ctx.rotate(Number(rotation) * Math.PI / 180);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    }
    ctx.restore();
}

function _ensurePreviewVideoDecodable(videoEl) {
    if (!videoEl || !_isPreviewVideoElement(videoEl) || !videoEl.style) return videoEl;
    const host = document.getElementById('reels-preview-container') || document.body;
    if (!videoEl.parentNode && host) {
        host.insertBefore(videoEl, host.firstChild || null);
    }
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.preload = 'auto';
    const style = videoEl.style;
    style.display = 'block';
    style.position = 'absolute';
    style.inset = '0';
    style.width = '100%';
    style.height = '100%';
    style.objectFit = style.objectFit || 'cover';
    style.opacity = '0.002'; // Use non-zero opacity to prevent Chromium from suspending paused video decoders
    style.visibility = 'visible';
    style.pointerEvents = 'none';
    style.zIndex = '0';
    return videoEl;
}

function _capturePreviewMediaFrame(media, token, target = null) {
    if (!media || !_isPreviewVideoElement(media) || !media.src) return false;
    _ensurePreviewVideoDecodable(media);
    const w = media.videoWidth || 0;
    const h = media.videoHeight || 0;
    if (!(w > 0) || !(h > 0)) return false;
    try {
        const frame = document.createElement('canvas');
        frame.width = w;
        frame.height = h;
        const fctx = frame.getContext('2d');
        fctx.drawImage(media, 0, 0, w, h);
        media._reelsSeekFrameCanvas = frame;
        media._reelsSeekFrameSrc = media.currentSrc || media.src;
        media._reelsSeekFrameToken = token;
        media._reelsSeekFrameTarget = Number.isFinite(target) ? target : (media.currentTime || 0);
        return true;
    } catch (e) {
        return false;
    }
}

function _getPreviewDrawableSource(media) {
    return media;
}

function _drawVideoCover(ctx, videoEl, targetW, targetH, scalePct, offsetX = 0, offsetY = 0, flipH = false, flipV = false, rotation = 0) {
    if (!ctx || !videoEl || !(targetW > 0) || !(targetH > 0)) return;
    const drawSource = _getPreviewDrawableSource(videoEl);
    const srcW = drawSource.videoWidth || drawSource.naturalWidth || drawSource.width || targetW;
    const srcH = drawSource.videoHeight || drawSource.naturalHeight || drawSource.height || targetH;
    if (!(srcW > 0) || !(srcH > 0)) {
        _drawImageFlipped(ctx, drawSource, 0, 0, targetW, targetH, undefined, undefined, undefined, undefined, flipH, flipV, rotation);
        return;
    }
    const userScale = (scalePct || 100) / 100;
    let scale = Math.max(targetW / srcW, targetH / srcH) * userScale;
    const radians = Math.abs((Number(rotation) || 0) % 180) * Math.PI / 180;
    const preRotateW = srcW * scale;
    const preRotateH = srcH * scale;
    const rotatedW = Math.abs(preRotateW * Math.cos(radians)) + Math.abs(preRotateH * Math.sin(radians));
    const rotatedH = Math.abs(preRotateW * Math.sin(radians)) + Math.abs(preRotateH * Math.cos(radians));
    scale *= Math.max(1, targetW / rotatedW, targetH / rotatedH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;
    const maxShiftX = Math.abs(targetW - drawW) / 2;
    const maxShiftY = Math.abs(targetH - drawH) / 2;
    const drawX = (targetW - drawW) / 2 + maxShiftX * (offsetX / 100);
    const drawY = (targetH - drawH) / 2 + maxShiftY * (offsetY / 100);
    _drawImageFlipped(ctx, drawSource, drawX, drawY, drawW, drawH, undefined, undefined, undefined, undefined, flipH, flipV, rotation);
}

function _parseCropString(cropStr) {
    let cropX = 0, cropY = 0, cropW = 1, cropH = 1;
    if (cropStr && typeof cropStr === 'string' && cropStr.trim() !== '') {
        const parts = cropStr.split(',').map(p => parseFloat(p.trim()));
        if (parts.length === 4 && parts.every(p => !isNaN(p))) {
            cropX = Math.max(0, Math.min(100, parts[0])) / 100;
            cropY = Math.max(0, Math.min(100, parts[1])) / 100;
            cropW = Math.max(1, Math.min(100, parts[2])) / 100;
            cropH = Math.max(1, Math.min(100, parts[3])) / 100;
        }
    }
    return { cropX, cropY, cropW, cropH };
}

function _drawCroppedVideoCover(ctx, videoEl, cropX, cropY, cropW, cropH, targetW, targetH, scalePct, offsetX = 0, offsetY = 0, flipH = false, flipV = false, rotation = 0) {
    if (!ctx || !videoEl || !(targetW > 0) || !(targetH > 0)) return;
    const drawSource = _getPreviewDrawableSource(videoEl);
    const srcW = drawSource.videoWidth || drawSource.naturalWidth || drawSource.width || targetW;
    const srcH = drawSource.videoHeight || drawSource.naturalHeight || drawSource.height || targetH;
    if (!(srcW > 0) || !(srcH > 0)) {
        _drawImageFlipped(ctx, drawSource, 0, 0, targetW, targetH, undefined, undefined, undefined, undefined, flipH, flipV, rotation);
        return;
    }
    const sx = srcW * cropX;
    const sy = srcH * cropY;
    const sWidth = srcW * cropW;
    const sHeight = srcH * cropH;

    const userScale = (scalePct || 100) / 100;
    let scale = Math.max(targetW / sWidth, targetH / sHeight) * userScale;
    const radians = Math.abs((Number(rotation) || 0) % 180) * Math.PI / 180;
    const preRotateW = sWidth * scale;
    const preRotateH = sHeight * scale;
    const rotatedW = Math.abs(preRotateW * Math.cos(radians)) + Math.abs(preRotateH * Math.sin(radians));
    const rotatedH = Math.abs(preRotateW * Math.sin(radians)) + Math.abs(preRotateH * Math.cos(radians));
    scale *= Math.max(1, targetW / rotatedW, targetH / rotatedH);
    const drawW = sWidth * scale;
    const drawH = sHeight * scale;
    const maxShiftX = Math.abs(targetW - drawW) / 2;
    const maxShiftY = Math.abs(targetH - drawH) / 2;
    const drawX = (targetW - drawW) / 2 + maxShiftX * (offsetX / 100);
    const drawY = (targetH - drawH) / 2 + maxShiftY * (offsetY / 100);
    _drawImageFlipped(ctx, drawSource, sx, sy, sWidth, sHeight, drawX, drawY, drawW, drawH, flipH, flipV, rotation);
}

// ═══════════════════════════════════════════════════════
// File / Task management
// ═══════════════════════════════════════════════════════

function _normalizeBaseName(name) {
    return String(name || '').replace(/\.[^.]+$/, '').trim().toLowerCase();
}

function _fileExt(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
}

function _isImagePath(filePath) {
    const ext = _fileExt(filePath || '');
    return ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp';
}

function _getSelectedTask() {
    if (_reelsState.selectedIdx < 0) return null;
    return _reelsState.tasks[_reelsState.selectedIdx] || null;
}

function _syncCurrentOverlayEditorToSelectedTask() {
    const task = _getSelectedTask();
    const mgr = _reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr;
    if (!task || !mgr) return;
    if (_reelsState._coverEditMode && task.cover) {
        task.cover.overlays = [...(mgr.overlays || [])];
    } else {
        task.overlays = [...(mgr.overlays || [])];
    }
    _updateTimelineForTask(task);
}

function _reelsFileExists(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    if (/^(blob:|data:|https?:)/i.test(filePath)) return true;
    if (window.electronAPI && typeof window.electronAPI.fileExists === 'function') {
        return window.electronAPI.fileExists(filePath);
    }
    return true;
}

function _toPlayablePath(filePath, srcUrl = null) {
    let url = '';
    if (srcUrl && _reelsFileExists(srcUrl)) url = srcUrl;
    else {
        if (!filePath || !_reelsFileExists(filePath)) return '';
        url = window.electronAPI?.toFileUrl?.(filePath) || _normalizeWatermarkPath(filePath);
    }
    // Only Reels playback requests use SDR proxies. Export keeps the source path.
    if (url.startsWith('local-media://') && /\.(mp4|mov|m4v|mkv|webm|avi|ts|mts|m2ts|3gp)(?:[?#]|$)/i.test(url)) {
        url = url.split('?')[0].split('#')[0] + '?reelsPreview=sdr-v2';
    }
    return url;
}

/**
 * 将 file:// URL 或编码路径还原为本地文件系统路径。
 * 与 _toPlayablePath 互为逆操作。
 */
function _normalizeLocalMediaPath(p) {
    if (!p) return '';
    let s = String(p);
    if (s.startsWith('local-media://')) s = s.split('?')[0].split('#')[0];
    // 去掉 local-media:// 或 file:// 前缀
    if (s.startsWith('local-media:///')) {
        s = s.slice(14);
    } else if (s.startsWith('local-media://')) {
        s = s.slice(14);
    } else if (s.startsWith('file:///')) {
        s = s.slice(7);
    } else if (s.startsWith('file://')) {
        s = s.slice(7);
    }
    
    // 统一将反斜杠替换为正斜杠，便于跨平台路径比较
    s = s.replace(/\\/g, '/');
    
    // 如果是 Windows 路径（比如 /C:/Users/...），去掉最开头的斜杠变为 C:/Users/...
    if (s.startsWith('/') && /^[a-zA-Z]:/.test(s.substring(1))) {
        s = s.substring(1);
    }
    
    // URI decode（处理中文路径等）
    try { s = decodeURIComponent(s); } catch (_) {}
    return s;
}

/**
 * 判断文件路径是否为图片（通过扩展名）。
 */
function _isImageFile(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext);
}

function _getReelsFastExportCapability(task, explicitBgPath = '') {
    if (!task) return { supported: false, reason: '缺少任务信息' };
    const bgPath = explicitBgPath || task.bgPath || task.videoPath || '';
    if (!bgPath) return { supported: false, reason: '缺少背景素材' };
    if (task.bgMode === 'multi' && _getEffectiveBgClipPool(task).length > 0) {
        return { supported: false, reason: '多背景片段需要逐帧合成' };
    }
    if (task.bgMode && task.bgMode !== 'single') {
        return { supported: false, reason: '当前背景模式不是单素材' };
    }
    if (task.contentVideoDirectBg || task.contentVideoBlurBg) {
        return { supported: false, reason: '内容视频背景需要逐帧合成' };
    }
    const showOverlay = _isReelsOverlayToggleEnabled();
    const hasBlendOverlay = showOverlay && (task.overlays || []).some((overlay) =>
        overlay && !overlay.disabled && overlay.blend_mode && overlay.blend_mode !== 'source-over'
    );
    if (hasBlendOverlay) {
        return { supported: false, reason: '覆层使用了混合模式' };
    }
    return { supported: true, reason: '单背景可直通，字幕和覆层使用透明画布' };
}

function _describeReelsFastCapability(capability, fastAlphaEnabled, fastEngineEnabled) {
    if (fastAlphaEnabled && capability.supported) {
        return { kind: 'full', reason: '已启用背景直通；字幕和覆层使用透明画布' };
    }
    if (capability.supported) {
        return { kind: 'available', reason: `${capability.reason}；当前输出模式未启用极速链路` };
    }
    return {
        kind: fastEngineEnabled ? 'partial' : 'unsupported',
        reason: `${capability.reason}${fastEngineEnabled ? '；仍保留批量流水线或硬件编码' : ''}`,
    };
}

function _resolvePreviewBackgroundPath(task) {
    if (!task) return { path: '', isMulti: false };
    const activePool = _getEffectiveBgClipPool(task);
    const isMulti = task.bgMode === 'multi' && activePool.length > 0;
    if (isMulti) {
        const previewPath = activePool.find(p => p && _reelsFileExists(p)) || activePool[0] || '';
        return { path: previewPath, isMulti: true };
    }
    return { path: task.bgPath || task.videoPath || '', isMulti: false };
}

function _getEffectiveBgClipPool(task) {
    if (!task || !Array.isArray(task.bgClipPool)) return [];
    const pool = task.bgClipPool.filter(Boolean);
    const active = Array.isArray(task.bgClipActivePool)
        ? task.bgClipActivePool.filter(p => p && pool.includes(p))
        : [];
    return active.length > 0 ? active : pool;
}

function _getEffectiveBgmClipPool(task) {
    if (!task || !Array.isArray(task.bgmClipPool)) return [];
    const pool = task.bgmClipPool.filter(Boolean);
    const active = Array.isArray(task.bgmClipActivePool)
        ? task.bgmClipActivePool.filter(p => p && pool.includes(p))
        : [];
    return active.length > 0 ? active : pool;
}

function _getEffectiveBgmPath(task, taskIdx) {
    if (!task) return '';
    if (task.bgmMode === 'multi') {
        const pool = _getEffectiveBgmClipPool(task).filter(p => p && _reelsFileExists(p));
        if (pool.length > 0) {
            if (task.bgmClipOrder === 'sequence') {
                return pool[taskIdx % pool.length];
            } else {
                const seedText = `${task.id || task.fileName || ''}|${taskIdx}|bgm-seed`;
                let seed = 2166136261;
                for (let i = 0; i < seedText.length; i++) {
                    seed ^= seedText.charCodeAt(i);
                    seed += (seed << 1) + (seed << 4) + (seed << 7) + (seed << 8) + (seed << 24);
                }
                const randIdx = Math.abs(seed) % pool.length;
                return pool[randIdx];
            }
        }
        return '';
    }
    return task.bgmPath || '';
}

window._getEffectiveBgmClipPool = _getEffectiveBgmClipPool;
window._getEffectiveBgmPath = _getEffectiveBgmPath;

function _getTaskBgmStart(task) {
    return Math.max(0, parseFloat(task && task.bgmStart) || 0);
}


function _getPreviewMultiClipPool(task) {
    if (!task || task.bgMode !== 'multi') return [];
    const pool = _getEffectiveBgClipPool(task).filter(p => p && _reelsFileExists(p));
    const isRandom = task.bgClipOrder === 'random' || task.bgClipOrder === 'random_align';
    if (!isRandom || pool.length <= 1) return pool;

    const seedText = `${task.id || task.fileName || ''}|${pool.join('|')}`;
    let seed = 2166136261;
    for (let i = 0; i < seedText.length; i++) {
        seed ^= seedText.charCodeAt(i);
        seed = Math.imul(seed, 16777619);
    }
    const rng = _mulberry32(seed >>> 0);
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function _calculatePreviewSegments(task) {
    const pool = _getPreviewMultiClipPool(task);
    if (pool.length === 0) return [];

    const bgDurFactor = (task && task.bgDurScale ? task.bgDurScale : 100) / 100;
    const videoEl = document.getElementById('reels-preview-video');

    const poolClips = pool.map(path => {
        let start = 0;
        let end = null;
        if (task.bgClipSettings && task.bgClipSettings[path]) {
            if (task.bgClipSettings[path].trimStart != null) start = parseFloat(task.bgClipSettings[path].trimStart) || 0;
            if (task.bgClipSettings[path].trimEnd != null) end = parseFloat(task.bgClipSettings[path].trimEnd) || null;
        }

        let dur = 5;
        if (!_isImageFile(path)) {
            if (end != null && end > 0) {
                dur = end - start;
            } else {
                if (videoEl && videoEl.dataset && videoEl.dataset.multiPath === path && isFinite(videoEl.duration) && videoEl.duration > 0) {
                    dur = videoEl.duration - start;
                } else {
                    dur = 5;
                }
            }
        }
        return {
            path,
            isImage: _isImageFile(path),
            trimStart: start,
            trimEnd: end,
            baseDuration: Math.max(0.5, dur) * bgDurFactor
        };
    });

    const isCardingMode = task.bgClipOrder === 'random_align' || task.bgClipOrder === 'sequence_align';
    const segments = task.segments || [];

    const audioEl = document.getElementById('reels-preview-audio');
    let totalDur = 15;
    if (audioEl && audioEl.src && isFinite(audioEl.duration) && audioEl.duration > 0) {
        totalDur = audioEl.duration;
    } else {
        totalDur = poolClips.reduce((sum, c) => sum + c.baseDuration, 0);
    }
    const audioDurScale = (task && task.audioDurScale ? task.audioDurScale : 100) / 100;
    if (audioEl && audioEl.src && audioDurScale !== 1.0) {
        totalDur = totalDur * audioDurScale;
    }

    const result = [];
    if (isCardingMode && segments.length > 0) {
        const cutPoints = [0];
        const candidates = [];
        const preSwitchOffset = 0.2;
        const bgMinClipDur = task.bgMinClipDur !== undefined ? task.bgMinClipDur : 5;
        const bgMaxClipDur = task.bgMaxClipDur !== undefined ? task.bgMaxClipDur : 7;

        for (const seg of segments) {
            const endVal = parseFloat(seg.end);
            if (!isNaN(endVal) && endVal > 0) {
                const shiftedPt = Math.max(0.1, endVal - preSwitchOffset);
                if (shiftedPt < totalDur) {
                    candidates.push(shiftedPt);
                }
            }
        }
        const getSentenceBoundaries = (segs, originalText) => {
            const strongBoundaries = new Set();
            const weakBoundaries = new Set();
            if (!segs || segs.length === 0) return { strongBoundaries, weakBoundaries };
            
            const lastIdx = segs.length - 1;
            strongBoundaries.add(lastIdx);

            const sentencePunct = new Set([
                '。', '！', '？', '，', '、', '；', '：', 
                '.', '!', '?', ',', ';', ':', '\n', '\r', 
                '…', '—', '“', '”', '‘', '’', '（', '）', 
                '(', ')', '[', ']', '【', '】'
            ]);
            const strongPunct = new Set(['。', '！', '？', '.', '!', '?', '\n', '\r', '…', '—']);

            segs.forEach((seg, i) => {
                const txt = String(seg.edited_text || seg.text || '').trim();
                if (txt && sentencePunct.has(txt[txt.length - 1])) {
                    const char = txt[txt.length - 1];
                    if (strongPunct.has(char)) {
                        strongBoundaries.add(i);
                    } else {
                        weakBoundaries.add(i);
                    }
                }
            });

            if (!originalText) return { strongBoundaries, weakBoundaries };

            const rawChars = Array.from(originalText);
            const cleanOriginalText = [];
            const cleanToRawMap = [];
            for (let i = 0; i < rawChars.length; i++) {
                const char = rawChars[i];
                if (!/\s/.test(char) && !sentencePunct.has(char)) {
                    cleanToRawMap.push(i);
                    cleanOriginalText.push(char);
                }
            }
            const cleanOrigStr = cleanOriginalText.join('');

            let accumulatedCleanText = "";
            for (let idx = 0; idx < segs.length; idx++) {
                const segVal = segs[idx].edited_text || segs[idx].text || "";
                const cleanSegText = String(segVal)
                    .replace(/\s+/g, '')
                    .split('')
                    .filter(c => !sentencePunct.has(c))
                    .join('');

                accumulatedCleanText += cleanSegText;
                if (accumulatedCleanText.length === 0) continue;

                const matchIdx = cleanOrigStr.toLowerCase().indexOf(accumulatedCleanText.toLowerCase());
                if (matchIdx !== -1) {
                    const endCleanIdx = matchIdx + accumulatedCleanText.length - 1;
                    const endRawIdx = cleanToRawMap[endCleanIdx];
                    if (endRawIdx !== undefined) {
                        let isBoundary = false;
                        let matchedChar = '';
                        let k = endRawIdx + 1;
                        for (; k < rawChars.length; k++) {
                            const nextChar = rawChars[k];
                            if (sentencePunct.has(nextChar)) {
                                isBoundary = true;
                                matchedChar = nextChar;
                                break;
                            }
                            if (!/\s/.test(nextChar)) {
                                break;
                            }
                        }
                        if (k === rawChars.length) {
                            isBoundary = true;
                        }
                        if (isBoundary) {
                            if (k === rawChars.length || strongPunct.has(matchedChar)) {
                                strongBoundaries.add(idx);
                            } else {
                                weakBoundaries.add(idx);
                            }
                        }
                    }
                }
            }
            return { strongBoundaries, weakBoundaries };
        };

        const originalScript = task.ttsText || task.aiScript || task.txtContent || "";
        const { strongBoundaries, weakBoundaries } = getSentenceBoundaries(segments, originalScript);

        const strongCandidates = [];
        const weakCandidates = [];
        const allCandidates = [];

        segments.forEach((seg, idx) => {
            const endVal = parseFloat(seg.end);
            if (!isNaN(endVal) && endVal > 0) {
                const shiftedPt = Math.max(0.1, endVal - preSwitchOffset);
                if (shiftedPt < totalDur) {
                    allCandidates.push(shiftedPt);
                    if (strongBoundaries.has(idx)) {
                        strongCandidates.push(shiftedPt);
                    } else if (weakBoundaries.has(idx)) {
                        weakCandidates.push(shiftedPt);
                    }
                }
            }
        });

        const sortedStrongCands = Array.from(new Set(strongCandidates)).sort((a, b) => a - b);
        const sortedWeakCands = Array.from(new Set(weakCandidates)).sort((a, b) => a - b);
        const sortedAllCands = Array.from(new Set(allCandidates)).sort((a, b) => a - b);

        const preferredSplit = Math.max(1.0, bgMinClipDur > 0 ? Math.min(bgMaxClipDur, bgMinClipDur + 1) : 5);
        const minOk = Math.max(1.0, bgMinClipDur - 1.0);
        const maxOk = bgMaxClipDur + 1.0;
        let lastCut = 0;
        let candIdx = 0;

        while (candIdx < sortedAllCands.length) {
            const remainingAll = sortedAllCands.filter(pt => pt > lastCut + 0.01);
            if (remainingAll.length === 0) break;

            const remainingStrong = sortedStrongCands.filter(pt => pt > lastCut + 0.01);
            const remainingWeak = sortedWeakCands.filter(pt => pt > lastCut + 0.01);

            let bestPt = null;
            // 1. 优先寻找区间内的强标点
            for (let i = 0; i < remainingStrong.length; i++) {
                const pt = remainingStrong[i];
                const dist = pt - lastCut;
                if (dist >= minOk && dist <= maxOk) {
                    if (bestPt === null || Math.abs(dist - preferredSplit) < Math.abs(bestPt - lastCut - preferredSplit)) {
                        bestPt = pt;
                    }
                }
            }

            // 2. 如果没有强标点，寻找弱标点
            if (bestPt === null) {
                for (let i = 0; i < remainingWeak.length; i++) {
                    const pt = remainingWeak[i];
                    const dist = pt - lastCut;
                    if (dist >= minOk && dist <= maxOk) {
                        if (bestPt === null || Math.abs(dist - preferredSplit) < Math.abs(bestPt - lastCut - preferredSplit)) {
                            bestPt = pt;
                        }
                    }
                }
            }

            if (bestPt !== null) {
                cutPoints.push(bestPt);
                lastCut = bestPt;
                const idx = sortedAllCands.indexOf(bestPt);
                candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
            } else {
                const hasExceedingStrong = remainingStrong.some(pt => pt - lastCut > maxOk);
                const hasExceedingWeak = remainingWeak.some(pt => pt - lastCut > maxOk);
                
                if (hasExceedingStrong || hasExceedingWeak) {
                    const smallerStrong = remainingStrong.filter(pt => pt - lastCut < minOk);
                    const smallerWeak = remainingWeak.filter(pt => pt - lastCut < minOk);
                    
                    if (smallerStrong.length > 0) {
                        const latestSmaller = smallerStrong[smallerStrong.length - 1];
                        cutPoints.push(latestSmaller);
                        lastCut = latestSmaller;
                        const idx = sortedAllCands.indexOf(latestSmaller);
                        candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
                    } else if (smallerWeak.length > 0) {
                        const latestSmaller = smallerWeak[smallerWeak.length - 1];
                        cutPoints.push(latestSmaller);
                        lastCut = latestSmaller;
                        const idx = sortedAllCands.indexOf(latestSmaller);
                        candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
                    } else {
                        let bestWordPt = null;
                        for (let i = 0; i < remainingAll.length; i++) {
                            const pt = remainingAll[i];
                            const dist = pt - lastCut;
                            if (dist >= minOk && dist <= maxOk) {
                                if (bestWordPt === null || Math.abs(dist - preferredSplit) < Math.abs(bestWordPt - lastCut - preferredSplit)) {
                                    bestWordPt = pt;
                                }
                            }
                        }
                        
                        if (bestWordPt !== null) {
                            cutPoints.push(bestWordPt);
                            lastCut = bestWordPt;
                            const idx = sortedAllCands.indexOf(bestWordPt);
                            candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
                        } else {
                            const nextForcedCut = lastCut + preferredSplit;
                            cutPoints.push(nextForcedCut);
                            lastCut = nextForcedCut;
                        }
                    }
                } else {
                    break;
                }
            }
        }

        if (bgMaxClipDur > 0) {
            while ((totalDur - lastCut) > bgMaxClipDur) {
                const nextForcedCut = lastCut + preferredSplit;
                cutPoints.push(nextForcedCut);
                lastCut = nextForcedCut;
            }
        }
        if (cutPoints.length > 1 && totalDur - cutPoints[cutPoints.length - 1] < 1.5) {
            cutPoints[cutPoints.length - 1] = totalDur;
        } else if (cutPoints[cutPoints.length - 1] < totalDur - 0.01) {
            cutPoints.push(totalDur);
        } else {
            cutPoints[cutPoints.length - 1] = totalDur;
        }

        for (let idx = 0; idx < cutPoints.length - 1; idx++) {
            const start = cutPoints[idx];
            const end = cutPoints[idx + 1];
            const dur = end - start;

            const clip = poolClips[idx % poolClips.length];
            result.push({
                path: clip.path,
                isImage: clip.isImage,
                start,
                end,
                duration: dur,
                trimStart: clip.trimStart,
                speedFactor: bgDurFactor
            });
        }
    } else {
        let cursor = 0;
        for (let i = 0; i < poolClips.length * 10; i++) {
            const clip = poolClips[i % poolClips.length];
            const start = cursor;
            const end = cursor + clip.baseDuration;
            result.push({
                path: clip.path,
                isImage: clip.isImage,
                start,
                end,
                duration: clip.baseDuration,
                trimStart: clip.trimStart,
                speedFactor: bgDurFactor
            });
            cursor = end;
            if (cursor >= totalDur) break;
        }
        if (result.length > 0) {
            const last = result[result.length - 1];
            if (last.end > totalDur) {
                last.end = totalDur;
                last.duration = last.end - last.start;
            }
        }
    }
    return result;
}

async function _preFetchMultiBgDurations(task) {
    if (!task || task.bgMode !== 'multi' || !Array.isArray(task.bgClipPool)) return;
    if (!_reelsState._multiBgDurations) _reelsState._multiBgDurations = {};
    const pool = _getPreviewMultiClipPool(task);
    for (const path of pool) {
        if (_isImageFile(path)) continue;
        if (_reelsState._multiBgDurations[path] > 0) continue;
        if (window.electronAPI && typeof window.electronAPI.getMediaDuration === 'function') {
            try {
                const dur = await window.electronAPI.getMediaDuration(path);
                if (dur > 0) {
                    _reelsState._multiBgDurations[path] = dur;
                    console.log(`[Preview] Loaded duration for ${path}: ${dur}s`);
                }
            } catch (e) {
                console.error('[Preview] Failed to get duration for', path, e);
            }
        }
    }
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
}

function _getPreviewMultiClipDuration(path, videoEl, task) {
    let start = 0;
    let end = null;
    if (task && task.bgClipSettings && task.bgClipSettings[path]) {
        if (task.bgClipSettings[path].trimStart != null) start = parseFloat(task.bgClipSettings[path].trimStart) || 0;
        if (task.bgClipSettings[path].trimEnd != null) end = parseFloat(task.bgClipSettings[path].trimEnd) || null;
    }

    let dur = 5;
    if (!_isImageFile(path)) {
        if (end != null && end > 0) {
            dur = end - start;
        } else {
            if (_reelsState._multiBgDurations && _reelsState._multiBgDurations[path] > 0) {
                dur = _reelsState._multiBgDurations[path] - start;
            } else if (videoEl && videoEl.dataset && videoEl.dataset.multiPath === path && isFinite(videoEl.duration) && videoEl.duration > 0) {
                dur = videoEl.duration - start;
            } else {
                dur = 5;
            }
        }
    }
    const bgDurFactor = (task && task.bgDurScale ? task.bgDurScale : 100) / 100;
    return Math.max(0.5, dur) * bgDurFactor;
}

function _resolvePreviewMultiClipsAtTime(task, timeSec) {
    const segments = _calculatePreviewSegments(task);
    if (segments.length === 0) return null;

    const total = segments[segments.length - 1].end;
    const loopTime = _isPreviewLoopEnabled() && total > 0
        ? (((timeSec || 0) % total) + total) % total
        : Math.min(timeSec || 0, Math.max(0, total - 0.001));

    const seg = segments.find(s => loopTime >= s.start && loopTime < s.end) || segments[segments.length - 1];
    const index = segments.indexOf(seg);

    const bgTransition = task.bgTransition || 'crossfade';
    const bgTransDur = task.bgTransDur || 0.5;
    const tDur = bgTransition !== 'none' ? bgTransDur : 0;

    let inTransition = false;
    let transitionProgress = 0;
    let prevSeg = null;

    if (tDur > 0 && index > 0 && loopTime >= seg.start && loopTime < seg.start + tDur) {
        inTransition = true;
        transitionProgress = (loopTime - seg.start) / tDur;
        prevSeg = segments[index - 1];
    }

    const getLocalTime = (s, time) => {
        const timeInSeg = time - s.start;
        return s.trimStart + timeInSeg / s.speedFactor;
    };

    return {
        current: {
            index,
            path: seg.path,
            isImage: seg.isImage,
            localTime: getLocalTime(seg, loopTime),
            duration: seg.duration
        },
        transition: inTransition ? {
            index: index - 1,
            path: prevSeg.path,
            isImage: prevSeg.isImage,
            localTime: getLocalTime(prevSeg, loopTime),
            duration: prevSeg.duration,
            progress: transitionProgress,
            type: bgTransition
        } : null,
        totalDuration: total
    };
}

function _syncPreviewMultiPlayers(task, clips) {
    const video = document.getElementById('reels-preview-video');
    const fadeVideo = _ensurePreviewFadeVideo(video);
    if (!video || !fadeVideo) return;

    const bgDurScale = task.bgDurScale || 100;
    const bgDurFactor = bgDurScale / 100;
    const targetPlaybackRate = (bgDurFactor !== 0) ? 1.0 / bgDurFactor : 1.0;

    const audio = document.getElementById('reels-preview-audio');
    const shouldPlay = !!_reelsState.mockPlaying || !!(audio && audio.src && !audio.paused);

    const cfg = _getPreviewAudioMixConfig();
    const effectiveBgGain = _getEffectiveBgVolumePercent(task, cfg.bgGain * 100) / 100;

    const syncPlayer = (player, path, localTime, gainMultiplier = 1) => {
        const url = _toPlayablePath(path, null);
        
        const norm = (s) => {
            if (!s) return '';
            try {
                let dec = decodeURIComponent(s);
                dec = dec.replace(/^file:\/\/\//i, '/').replace(/^file:\/\//i, '/');
                dec = dec.replace(/\\/g, '/');
                dec = dec.replace(/\/+/g, '/');
                return dec;
            } catch (_) {
                return s;
            }
        };

        if (norm(player.src) !== norm(url) || player.dataset.multiPath !== path) {
            player.pause();
            player.src = url;
            player.dataset.multiPath = path;
            player.load();
        }
        player.playbackRate = targetPlaybackRate;
        player.preservesPitch = true;

        const targetTime = player.duration > 0 ? Math.min(localTime, Math.max(0, player.duration - 0.03)) : localTime;
        if (player.readyState >= 1 && Math.abs((player.currentTime || 0) - targetTime) > 0.25) {
            try { player.currentTime = targetTime; } catch (_) { }
        }

        // Apply volume/muted status on every sync, especially after load()
        const ctx = _reelsState._audioCtx;
        const useWebAudio = !!(ctx && _reelsState._gainNodes);
        const vol = Math.max(0, Math.min(1, effectiveBgGain * gainMultiplier));
        if (useWebAudio && _reelsState._gainNodes.has(player)) {
            const gainNode = _reelsState._gainNodes.get(player);
            gainNode.gain.setValueAtTime(vol, ctx.currentTime);
            player.volume = vol > 0 ? 1.0 : 0;
            player.muted = vol <= 0.0001;
        } else {
            player.volume = Math.min(1.0, vol);
            player.muted = vol <= 0.0001;
        }

        if (shouldPlay && player.paused) {
            player.play().catch(() => { });
        } else if (!shouldPlay && !player.paused) {
            player.pause();
        }
    };

    if (clips.transition) {
        const outgoing = clips.transition;
        const incoming = clips.current;
        const transitionProgress = Math.max(0, Math.min(1, outgoing.progress || 0));
        const outgoingGain = 1 - transitionProgress;
        const incomingGain = transitionProgress;

        if (outgoing.isImage && incoming.isImage) {
            video.pause();
            fadeVideo.pause();
        } else if (outgoing.isImage) {
            video.style.display = 'block';
            syncPlayer(video, incoming.path, incoming.localTime, 1);
            fadeVideo.pause();
        } else if (incoming.isImage) {
            video.style.display = 'block';
            syncPlayer(video, outgoing.path, outgoing.localTime, 1);
            fadeVideo.pause();
        } else {
            video.style.display = 'block';
            fadeVideo.style.display = 'block';

            if (video.dataset.multiPath === outgoing.path) {
                syncPlayer(video, outgoing.path, outgoing.localTime, outgoingGain);
                syncPlayer(fadeVideo, incoming.path, incoming.localTime, incomingGain);
            } else if (fadeVideo.dataset.multiPath === outgoing.path) {
                syncPlayer(fadeVideo, outgoing.path, outgoing.localTime, outgoingGain);
                syncPlayer(video, incoming.path, incoming.localTime, incomingGain);
            } else {
                syncPlayer(video, outgoing.path, outgoing.localTime, outgoingGain);
                syncPlayer(fadeVideo, incoming.path, incoming.localTime, incomingGain);
            }
        }
    } else {
        const current = clips.current;

        if (current.isImage) {
            video.pause();
            fadeVideo.pause();
        } else {
            video.style.display = 'block';
            if (fadeVideo.dataset.multiPath === current.path && !video.dataset.multiPath) {
                syncPlayer(fadeVideo, current.path, current.localTime);
                video.pause();
            } else {
                syncPlayer(video, current.path, current.localTime);
                fadeVideo.pause();
            }
        }
    }
}

function _drawPreviewMultiBackground(ctx, w, h, bgScale, bgX, bgY, bgRotation, clips) {
    if (!clips) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        return;
    }
    const task = _getSelectedTask();
    const video = document.getElementById('reels-preview-video');
    const fadeVideo = _reelsState.previewFadeVideo;

    const getDrawSource = (clip) => {
        if (clip.isImage) {
            if (!_reelsState._multiBgImages) _reelsState._multiBgImages = {};
            let img = _reelsState._multiBgImages[clip.path];
            if (!img) {
                img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => { if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview(); };
                img.src = _toPlayablePath(clip.path, null);
                _reelsState._multiBgImages[clip.path] = img;
            }
            return (img.complete && img.naturalWidth > 0) ? img : null;
        } else {
            if (video && video.dataset.multiPath === clip.path && video.readyState >= 1) {
                return video;
            }
            if (fadeVideo && fadeVideo.dataset.multiPath === clip.path && fadeVideo.readyState >= 1) {
                return fadeVideo;
            }
            return null;
        }
    };

    const drawClip = (clip) => {
        const src = getDrawSource(clip);
        if (src) {
            _drawVideoCover(ctx, src, w, h, bgScale, bgX, bgY, task?.bgFlipH || false, task?.bgFlipV || false, bgRotation);
        } else {
            ctx.fillStyle = '#1e1e1e';
            ctx.fillRect(0, 0, w, h);
        }
    };

    if (clips.transition) {
        const outgoing = clips.transition;
        const incoming = clips.current;
        const progress = outgoing.progress;
        const type = outgoing.type;

        drawClip(outgoing);

        ctx.save();
        if (type === 'crossfade' || type === 'fade') {
            ctx.globalAlpha = progress;
            drawClip(incoming);
        } else if (type === 'fade_black' || type === 'fadeblack') {
            if (progress < 0.5) {
                const alpha = progress * 2;
                ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
                ctx.fillRect(0, 0, w, h);
            } else {
                const alpha = (progress - 0.5) * 2;
                ctx.globalAlpha = alpha;
                drawClip(incoming);
            }
        } else if (type === 'fade_white' || type === 'fadewhite') {
            if (progress < 0.5) {
                const alpha = progress * 2;
                ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
                ctx.fillRect(0, 0, w, h);
            } else {
                const alpha = (progress - 0.5) * 2;
                ctx.globalAlpha = alpha;
                drawClip(incoming);
            }
        } else if (type === 'slide_left' || type === 'slideleft') {
            ctx.beginPath();
            ctx.rect(w * (1 - progress), 0, w * progress, h);
            ctx.clip();
            drawClip(incoming);
        } else if (type === 'slide_right' || type === 'slideright') {
            ctx.beginPath();
            ctx.rect(0, 0, w * progress, h);
            ctx.clip();
            drawClip(incoming);
        } else if (type === 'wipe' || type === 'wipeleft') {
            ctx.beginPath();
            ctx.rect(0, 0, w * progress, h);
            ctx.clip();
            drawClip(incoming);
        } else {
            drawClip(incoming);
        }
        ctx.restore();
    } else {
        drawClip(clips.current);
    }
}

function _resolvePreviewMultiClipAtTime(task, timeSec) {
    const segments = _calculatePreviewSegments(task);
    if (segments.length === 0) return null;

    const total = segments[segments.length - 1].end;
    const loopTime = _isPreviewLoopEnabled() && total > 0
        ? (((timeSec || 0) % total) + total) % total
        : Math.min(timeSec || 0, Math.max(0, total - 0.001));

    const seg = segments.find(s => loopTime >= s.start && loopTime < s.end) || segments[segments.length - 1];
    
    const timeInSeg = loopTime - seg.start;
    const localTime = seg.trimStart + timeInSeg / seg.speedFactor;

    return {
        index: segments.indexOf(seg),
        path: seg.path,
        isImage: seg.isImage,
        localTime: localTime,
        duration: seg.duration,
        totalDuration: total
    };
}

function _syncPreviewMultiBackground(task, contentTime) {
    const clips = _resolvePreviewMultiClipsAtTime(task, contentTime);
    if (!clips) return null;
    _syncPreviewMultiPlayers(task, clips);
    return clips;
}

/**
 * 解析任务的 Hook（前置视频）路径。
 * 优先级: task.hookFile → task.hook.path → 全局前置路径。
 * 若 task.hookFile === '__NONE__' 则显式禁用。
 */
function _resolveTaskHookPath(task, globalIntroPath) {
    if (!task) return globalIntroPath || '';
    // 显式禁用 hook
    if (task.hookFile === '__NONE__') return '';
    // 任务级 hook 优先
    if (task.hookFile) return task.hookFile;
    if (task.hook && task.hook.path) return task.hook.path;
    // 回退到全局前置路径
    return globalIntroPath || '';
}

function _getAudioDuration(task) {
    if (!task || !task.audioPath) return 0;
    if (_reelsState._mediaDurations && _reelsState._mediaDurations[task.audioPath] > 0) {
        return _reelsState._mediaDurations[task.audioPath];
    }
    if (task === _getSelectedTask()) {
        const audio = document.getElementById('reels-preview-audio');
        if (audio && isFinite(audio.duration) && audio.duration > 0) {
            return audio.duration;
        }
    }
    if (task.segments && task.segments.length > 0) {
        return task.segments[task.segments.length - 1].end || 0;
    }
    return 0;
}

function _getVideoDuration(task) {
    if (!task) return 0;
    const previewBg = _resolvePreviewBackgroundPath(task);
    const bgPath = previewBg.path;
    if (!bgPath || previewBg.isMulti || _isImagePath(bgPath)) return 0;
    if (_reelsState._mediaDurations && _reelsState._mediaDurations[bgPath] > 0) {
        return _reelsState._mediaDurations[bgPath];
    }
    if (task === _getSelectedTask()) {
        const video = document.getElementById('reels-preview-video');
        if (video && isFinite(video.duration) && video.duration > 0) {
            return video.duration;
        }
    }
    return 0;
}

function _getContentVideoDuration(task) {
    if (!task || !task.contentVideoPath) return 0;
    if (_reelsState._mediaDurations && _reelsState._mediaDurations[task.contentVideoPath] > 0) {
        const fullDur = _reelsState._mediaDurations[task.contentVideoPath];
        const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
        const trimEnd = parseFloat(task.contentVideoTrimEnd) || 0;
        if (trimEnd > trimStart && trimStart >= 0) {
            return trimEnd - trimStart;
        }
        return Math.max(0, fullDur - trimStart);
    }
    if (task === _getSelectedTask()) {
        const cvVideo = document.getElementById('reels-preview-contentvideo');
        if (cvVideo && cvVideo.src && isFinite(cvVideo.duration) && cvVideo.duration > 0) {
            const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
            const trimEnd = parseFloat(task.contentVideoTrimEnd) || 0;
            if (trimEnd > trimStart && trimStart >= 0) {
                return trimEnd - trimStart;
            }
            return Math.max(0, cvVideo.duration - trimStart);
        }
    }
    if (_reelsState.cvSequence && _reelsState.cvSequence.path === task.contentVideoPath && _reelsState.cvSequence.files.length > 0) {
        return _reelsState.cvSequence.files.length / 30;
    }
    return 0;
}




function _getPreviewMasterElement() {
    const task = _getSelectedTask();
    if (!task) return null;
    const audio = document.getElementById('reels-preview-audio');
    if (task.audioPath && audio && audio.src && audio.readyState >= 1) return audio;
    if (!(task.contentVideoDirectBg && task.contentVideoPath)) {
        const previewBg = _resolvePreviewBackgroundPath(task);
        if (!previewBg.isMulti) {
            const video = document.getElementById('reels-preview-video');
            const isVideo = previewBg.path && !_isImagePath(previewBg.path);
            if (isVideo && video && video.src && video.readyState >= 1) return video;
        }
    }
    // 内容视频作为时钟源（当没有单独配音和背景视频时）
    const cvVideo = document.getElementById('reels-preview-contentvideo');
    if (task.contentVideoPath && cvVideo && cvVideo.src && cvVideo.readyState >= 1) return cvVideo;
    const bgm = _reelsState._bgmAudioEl;
    if (task.bgmPath && bgm && bgm.src && bgm.readyState >= 1) return bgm;
    return null;
}

function _isPreviewLoopEnabled() {
    const el = document.getElementById('reels-preview-loop');
    return el ? !!el.checked : true;
}

function _applyPreviewLoopMode() {
    const enabled = _isPreviewLoopEnabled();
    const task = _getSelectedTask();
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const cvVideo = document.getElementById('reels-preview-contentvideo');
    const bgm = _reelsState._bgmAudioEl;

    const hasAudio = !!(task && task.audioPath && audio && audio.src);
    const previewBg = _resolvePreviewBackgroundPath(task);
    const hasVideo = !!(task && !previewBg.isMulti && previewBg.path && !_isImagePath(previewBg.path) && video && video.src);
    const hasCvVideo = !!(task && task.contentVideoPath && cvVideo && cvVideo.src);

    if (audio) audio.loop = enabled && hasAudio;
    if (video) video.loop = enabled && hasVideo;
    if (cvVideo) cvVideo.loop = enabled && hasCvVideo;
    if (bgm) bgm.loop = enabled;
    if (_reelsState.previewFadeVideo) _reelsState.previewFadeVideo.loop = enabled;
}

function reelsOnPreviewLoopModeChange() {
    _applyPreviewLoopMode();
}

function _getPreviewCurrentTime() {
    const task = _getSelectedTask();
    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const offsetDur = hookDur + coverDur;

    if (_isPreviewSeekLocked()) {
        return _reelsState.previewSeekLock.target;
    }

    // When mock clock is running (Cover/Hook phases, or no-media mode), use it as primary
    if (_reelsState.mockPlaying) {
        const elapsed = Math.max(0, (performance.now() / 1000) - (_reelsState.mockStartTime || 0));
        if (_isPreviewLoopEnabled()) {
            const dur = _getPreviewDuration();
            if (dur > 0) return elapsed % dur;
        }
        return elapsed;
    }

    // Master media actively playing (main content phase after Cover+Hook)
    const master = _getPreviewMasterElement();
    if (_isPreviewMediaPlaying(master)) {
        let t = master.currentTime || 0;
        if (master.id === 'reels-preview-contentvideo') {
            const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
            t = Math.max(0, t - trimStart);
        }
        const aDurScale = (task && task.audioDurScale) ? (task.audioDurScale / 100) : 1;
        return (t * aDurScale) + offsetDur;
    }

    // Paused state (initial, after seek, after user pause): use saved position
    return _reelsState.mockPausedTime || 0;
}

function _getPreviewPlaybackTimeForPause() {
    const task = _getSelectedTask();
    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const offsetDur = hookDur + coverDur;

    if (_reelsState.mockPlaying) {
        const elapsed = Math.max(0, (performance.now() / 1000) - (_reelsState.mockStartTime || 0));
        if (_isPreviewLoopEnabled()) {
            const dur = _getPreviewDuration();
            if (dur > 0) return elapsed % dur;
        }
        return elapsed;
    }

    const hookVideo = document.getElementById('reels-preview-hook-video');
    if (task && hookVideo && hookVideo.src && _isPreviewMediaPlaying(hookVideo)) {
        const trimStart = (task.hookTrimStart != null && task.hookTrimStart > 0) ? task.hookTrimStart : 0;
        const speed = task.hookSpeed || 1.0;
        return coverDur + Math.max(0, (hookVideo.currentTime || 0) - trimStart) / Math.max(speed, 0.0001);
    }

    const master = _getPreviewMasterElement();
    if (_isPreviewMediaPlaying(master)) {
        let t = master.currentTime || 0;
        if (master.id === 'reels-preview-contentvideo') {
            const trimStart = parseFloat((task || {}).contentVideoTrimStart) || 0;
            t = Math.max(0, t - trimStart);
        }
        const aDurScale = (task && task.audioDurScale) ? (task.audioDurScale / 100) : 1;
        return (t * aDurScale) + offsetDur;
    }

    return _reelsState.mockPausedTime || 0;
}

function _isPreviewActuallyPlaying(master, hookVideo, bgmAudio) {
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const contentVideo = document.getElementById('reels-preview-contentvideo');
    const fadeVideo = _reelsState.previewFadeVideo;
    return !!(
        _reelsState.mockPlaying ||
        _isPreviewMediaPlaying(master) ||
        _isPreviewMediaPlaying(hookVideo) ||
        _isPreviewMediaPlaying(audio) ||
        _isPreviewMediaPlaying(video) ||
        _isPreviewMediaPlaying(fadeVideo) ||
        _isPreviewMediaPlaying(contentVideo) ||
        _isPreviewMediaPlaying(bgmAudio)
    );
}

function _isPreviewMediaPlaying(media) {
    return !!(media && !media.paused && !media._reelsSeekPriming);
}

function _getPreviewDuration() {
    const task = _getSelectedTask();
    const audio = document.getElementById('reels-preview-audio');
    const video = document.getElementById('reels-preview-video');
    
    // ⏱ 文字翻转器 (Dynamic Flipper) 时长优先
    let maxFlipperDuration = 0;
    if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        for (const ov of (_reelsState.overlayProxy.overlayMgr.overlays || [])) {
            if (ov && !ov.disabled && ov.flipper_enabled) {
                const text = (ov.type === 'textcard') ? (ov.body_text || '') : (ov.content || '');
                const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                const flipper_lines = parseInt(ov.flipper_lines) || 2;
                const flipper_duration = parseFloat(ov.flipper_duration) || 2.0;
                const totalChunks = Math.ceil(lines.length / flipper_lines);
                const flipperDur = (parseFloat(ov.start) || 0) + (totalChunks * flipper_duration);
                if (flipperDur > maxFlipperDuration) {
                    maxFlipperDuration = flipperDur;
                }
            }
        }
    }

    const subDur = task && task.segments && task.segments.length > 0
        ? (task.segments[task.segments.length - 1].end || 0)
        : 0;
    const aDur = _getAudioDuration(task);
    const vDur = _getVideoDuration(task);

    // 音频变速：audioDurScale=150% → 实际播放时长 = 原时长 × 1.5
    const aDurScale = (task && task.audioDurScale) ? (task.audioDurScale / 100) : 1;
    const scaledADur = aDur * aDurScale;

    // 前置阶段总时长
    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const offsetDur = hookDur + coverDur;

    if (maxFlipperDuration > 0) {
        return maxFlipperDuration + offsetDur;
    }

    // 自定义时长优先
    const globalCustomEl = document.getElementById('reels-custom-duration');
    const globalCustomDuration = parseFloat(globalCustomEl ? globalCustomEl.value : '0') || 0;
    const effectiveCustomDuration = resolveReelsCustomDuration(task, globalCustomDuration);
    if (effectiveCustomDuration > 0) {
        return effectiveCustomDuration + offsetDur;
    }
    // 有音频时以变速后的音频时长为准（背景自动循环）
    if (scaledADur > 0) {
        return scaledADur + offsetDur;
    }

    // ── 内容视频 (Content Video) 时长优先于背景 ──
    const cvVideo = document.getElementById('reels-preview-contentvideo');
    let cvDur = 0;
    if (task && task.contentVideoPath) {
        // 情况1: 图片序列文件夹 → duration = frameCount / 30
        if (_reelsState.cvSequence && _reelsState.cvSequence.path === task.contentVideoPath && _reelsState.cvSequence.files.length > 0) {
            cvDur = _reelsState.cvSequence.files.length / 30;
        }
        // 情况2: 普通视频文件 → 用 <video> 元素的 duration
        else if (cvVideo && cvVideo.src && isFinite(cvVideo.duration) && cvVideo.duration > 0) {
            const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
            const trimEnd   = parseFloat(task.contentVideoTrimEnd) || 0;
            if (trimEnd > trimStart && trimStart >= 0) {
                cvDur = trimEnd - trimStart;
            } else {
                cvDur = cvVideo.duration - trimStart;
            }
        }
    }
    if (cvDur > 0) {
        return Math.max(cvDur, subDur) + offsetDur;
    }

    if (task && task.bgMode === 'multi' && _getEffectiveBgClipPool(task).length > 0) {
        const isCardingMode = task.bgClipOrder === 'random_align' || task.bgClipOrder === 'sequence_align';
        if (isCardingMode && subDur > 0) {
            return subDur + offsetDur;
        }
        const pool = _getPreviewMultiClipPool(task);
        const rawMultiDur = pool.reduce((sum, path) => {
            return sum + _getPreviewMultiClipDuration(path, video, task);
        }, 0);
        const transOverlap = task.bgTransition !== 'none' ? (parseFloat(task.bgTransDur) || 0.5) : 0;
        const multiDur = Math.max(0.5, rawMultiDur - transOverlap * Math.max(0, pool.length - 1));
        if (multiDur > 0) return Math.max(multiDur, subDur) + offsetDur;
    }

    // 无音频、无覆层视频时以背景视频时长为准，若仍无时长则推算虚拟进度
    const bDurScale = (task && task.bgDurScale) ? (task.bgDurScale / 100) : 1;
    // 由“文案自动剪辑”送入的任务会在接收时直接记录导出成片时长，避免
    // 媒体元数据尚未异步读取完成时，预览错误地退回到字幕最后一句的时间。
    const baseDur = Math.max(vDur * bDurScale, Number(task?.duration) || 0, subDur, 0);
    if (baseDur <= 0 && !_getPreviewMasterElement()) {
        let maxOverlayEnd = 0;
        if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
            for (const ov of (_reelsState.overlayProxy.overlayMgr.overlays || [])) {
                const ovEnd = parseFloat(ov.end || 0);
                // 跳过 9999（全程标记），它不代表实际时长
                if (ovEnd >= 9999) continue;
                if (ovEnd > maxOverlayEnd) maxOverlayEnd = ovEnd;
            }
        }
        const demoWords = ((document.getElementById('reels-preview-text') || {}).value || '').split(/\s+/).filter(Boolean);
        const totalDur = Math.max(3, (demoWords.length || 1) * 0.6);
        const contentDur = maxOverlayEnd > 0 ? maxOverlayEnd + 0.5 : totalDur;
        return contentDur + offsetDur;
    }
    return baseDur + offsetDur;
}

function _getPreviewLoopFadeConfig() {
    const loopFadeEl = document.getElementById('reels-loop-fade');
    const loopFadeDurEl = document.getElementById('reels-loop-fade-dur');
    const enabled = loopFadeEl ? loopFadeEl.checked : true;
    let duration = parseFloat(loopFadeDurEl ? loopFadeDurEl.value : '1');
    if (!Number.isFinite(duration) || duration <= 0) duration = 1.0;
    duration = Math.max(0.1, Math.min(3, duration));
    return { enabled, duration };
}

function _setExportSettingValue(id, val) {
    const el = document.getElementById(id);
    const rangeEl = document.getElementById(id + '-range') || (id === 'reels-bg-volume' ? document.getElementById('reels-bg-volume-range-global') : null);
    const raw = val == null ? '' : String(val);
    if (el) el.value = raw;
    if (rangeEl) rangeEl.value = (id === 'reels-custom-duration' && raw === '') ? '0' : raw;
}

function _bindExportSliderNumber(id, opts = {}) {
    const num = document.getElementById(id);
    const range = document.getElementById(opts.rangeId || `${id}-range`);
    if (!num || !range || range.dataset.bound === 'true') return;
    range.dataset.bound = 'true';
    const normalizeForRange = (value) => {
        if (opts.blankOnZero && (value === '' || value == null)) return '0';
        return String(value);
    };
    const normalizeForNumber = (value) => {
        if (opts.blankOnZero && parseFloat(value) === 0) return '';
        return String(value);
    };
    const fire = () => {
        if (typeof opts.onChange === 'function') opts.onChange();
    };
    range.addEventListener('input', () => {
        num.value = normalizeForNumber(range.value);
        fire();
    });
    num.addEventListener('input', () => {
        range.value = normalizeForRange(num.value);
        fire();
    });
    range.value = normalizeForRange(num.value);
}

function _initExportSettingSliders() {
    const refreshPreviewAudio = () => {
        if (typeof _applyPreviewAudioMix === 'function') _applyPreviewAudioMix();
    };
    const refreshPreview = () => {
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    };
    _bindExportSliderNumber('reels-custom-duration', { blankOnZero: true });
    _bindExportSliderNumber('reels-voice-volume', { onChange: refreshPreviewAudio });
    _bindExportSliderNumber('reels-bg-volume', { rangeId: 'reels-bg-volume-range-global', onChange: refreshPreviewAudio });
    _bindExportSliderNumber('reels-bgm-volume', { onChange: refreshPreviewAudio });
    _bindExportSliderNumber('reels-reverb-mix', { onChange: refreshPreviewAudio });
    _bindExportSliderNumber('reels-stereo-width', { onChange: refreshPreviewAudio });
    _bindExportSliderNumber('reels-loop-fade-dur', { onChange: refreshPreview });
    _bindExportSliderNumber('reels-export-concurrency');
}

// 导出设置独立保存，重新打开 Reels 时恢复上次使用的组合。
const REELS_EXPORT_SETTINGS_STORAGE_KEY = 'videokit_reels_export_settings_v1';
const REELS_EXPORT_SETTING_DEFAULTS = {
    'reels-quality': 'low',
    'reels-custom-bitrate': '5',
    'reels-custom-max-bitrate': '7',
    'reels-export-engine': 'precise',
    'reels-suffix': '_subtitled',
    'reels-custom-duration': '',
    'reels-use-gpu': true,
    'reels-use-memory-decoder': true,
    'reels-voice-volume': '100',
    'reels-bg-volume': '100',
    'reels-bgm-volume': '30',
    'reels-reverb-enabled': false,
    'reels-reverb-preset': 'hall',
    'reels-reverb-mix': '15',
    'reels-stereo-width': '100',
    'reels-audio-fx-target': 'all',
    'reels-multi-preset-enabled': false,
    'reels-mp-naming': 'flat',
    'reels-loop-fade': true,
    'reels-fast-alpha-mode': true,
    'reels-loop-fade-dur': '1',
    'reels-resolution-select': '1080x1920',
    'reels-export-concurrency': '1',
    'reels-export-recycle-every': String(REELS_EXPORT_RECYCLE_EVERY_DEFAULT),
    'reels-copy-project-to-output': false,
};
const REELS_EXPORT_SETTING_LABELS = {
    'reels-quality': '画质', 'reels-custom-bitrate': '目标码率', 'reels-custom-max-bitrate': '最大码率',
    'reels-export-engine': '渲染引擎', 'reels-suffix': '文件后缀', 'reels-custom-duration': '成片时长',
    'reels-use-gpu': 'GPU 编码', 'reels-use-memory-decoder': '极速内存渲染',
    'reels-voice-volume': '人声音量', 'reels-bg-volume': '背景音量', 'reels-bgm-volume': '配乐音量',
    'reels-reverb-enabled': '混响', 'reels-reverb-preset': '混响预设', 'reels-reverb-mix': '混响量',
    'reels-stereo-width': '立体声宽度', 'reels-audio-fx-target': '音效作用音轨',
    'reels-multi-preset-enabled': '多模板矩阵导出', 'reels-mp-naming': '矩阵命名方式',
    'reels-loop-fade': '循环透明过渡', 'reels-fast-alpha-mode': '极速贴合模式',
    'reels-loop-fade-dur': '过渡时长', 'reels-resolution-select': '分辨率',
    'reels-export-concurrency': '并发数',
    'reels-export-recycle-every': '队列刷新间隔',
    'reels-copy-project-to-output': '导出后复制工程包',
};

function _readReelsExportSettings() {
    const settings = {};
    Object.keys(REELS_EXPORT_SETTING_DEFAULTS).forEach(id => {
        const el = document.getElementById(id);
        if (el) settings[id] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return settings;
}

function _saveReelsExportSettings() {
    try {
        localStorage.setItem(REELS_EXPORT_SETTINGS_STORAGE_KEY, JSON.stringify(_readReelsExportSettings()));
    } catch (error) {
        console.warn('[Reels] 保存导出设置失败:', error);
    }
}

// 只重置导出参数，不动任务、已导入素材或用户选定的输出目录。
function reelsResetExportSettings() {
    if (!confirm('恢复导出设置默认值？\n\n不会删除任务、素材或输出目录。')) return;
    Object.entries(REELS_EXPORT_SETTING_DEFAULTS).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = Boolean(value);
        else _setExportSettingValue(id, value);
    });

    reelsUpdateCustomBitrateUI();
    reelsUpdateExportEngineUI();
    if (typeof reelsHandleResolutionChange === 'function') {
        reelsHandleResolutionChange((document.getElementById('reels-resolution-select') || {}).value);
    }
    // 多模板区有自己的展开/收起状态，需要主动刷新一次。
    document.getElementById('reels-multi-preset-enabled')?.dispatchEvent(new Event('change'));
    if (typeof _applyPreviewAudioMix === 'function') _applyPreviewAudioMix();
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    _saveReelsExportSettings();
    if (typeof showToast === 'function') showToast('导出设置已恢复默认值', 'success');
}

function _initReelsExportSettingsPersistence() {
    if (window._reelsExportSettingsPersistenceReady) return;
    window._reelsExportSettingsPersistenceReady = true;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(REELS_EXPORT_SETTINGS_STORAGE_KEY) || '{}') || {}; } catch (_) { }
    Object.entries(saved).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (!el || !(id in REELS_EXPORT_SETTING_DEFAULTS)) return;
        if (el.type === 'checkbox') el.checked = Boolean(value);
        else el.value = String(value ?? '');
    });
    // 还原后同步关联 UI（码率、引擎说明、分辨率与滑块）。
    reelsUpdateCustomBitrateUI();
    reelsUpdateExportEngineUI();
    if (typeof reelsHandleResolutionChange === 'function') {
        reelsHandleResolutionChange((document.getElementById('reels-resolution-select') || {}).value);
    }
    let saveTimer;
    Object.keys(REELS_EXPORT_SETTING_DEFAULTS).forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const scheduleSave = () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(_saveReelsExportSettings, 120);
        };
        el.addEventListener('input', scheduleSave);
        el.addEventListener('change', scheduleSave);
    });
}

function _getReelsExportCustomSettingsSummary() {
    const settings = _readReelsExportSettings();
    return Object.keys(REELS_EXPORT_SETTING_DEFAULTS).filter(id => {
        if (!(id in settings)) return false;
        return String(settings[id]) !== String(REELS_EXPORT_SETTING_DEFAULTS[id]);
    }).map(id => REELS_EXPORT_SETTING_LABELS[id] || id);
}

function _getPreviewAudioMixConfig() {
    let voiceVolume = parseFloat((document.getElementById('reels-voice-volume') || {}).value || '100');
    let bgVolume = _getGlobalBgVolumePercent();
    let bgmVolume = _getGlobalBgmVolumePercent();
    if (!Number.isFinite(voiceVolume)) voiceVolume = 100;
    if (!Number.isFinite(bgVolume)) bgVolume = 100;
    if (!Number.isFinite(bgmVolume)) bgmVolume = 30;
    voiceVolume = Math.max(0, voiceVolume);
    bgVolume = Math.max(0, bgVolume);
    bgmVolume = Math.max(0, bgmVolume);
    return { voiceGain: voiceVolume / 100, bgGain: bgVolume / 100, bgmGain: bgmVolume / 100 };
}

function _getGlobalBgVolumePercent() {
    const bgVolumeEl = document.getElementById('reels-bg-volume');
    const bgVolume = parseFloat(bgVolumeEl ? bgVolumeEl.value : '100');
    return Number.isFinite(bgVolume) ? Math.max(0, bgVolume) : 100;
}

function _getGlobalVoiceVolumePercent() {
    const voiceVolumeEl = document.getElementById('reels-voice-volume');
    const voiceVolume = parseFloat(voiceVolumeEl ? voiceVolumeEl.value : '100');
    return Number.isFinite(voiceVolume) ? Math.max(0, voiceVolume) : 100;
}

function _getGlobalBgmVolumePercent() {
    const bgmVolumeEl = document.getElementById('reels-bgm-volume');
    const bgmVolume = parseFloat(bgmVolumeEl ? bgmVolumeEl.value : '30');
    return Number.isFinite(bgmVolume) ? Math.max(0, bgmVolume) : 30;
}

function _getEffectiveBgVolumePercent(task, globalBgVolume = _getGlobalBgVolumePercent()) {
    const raw = task && task.bgVideoVolume != null ? parseFloat(task.bgVideoVolume) : NaN;
    if (Number.isFinite(raw)) return Math.max(0, globalBgVolume) * Math.max(0, raw) / 100;

    if (task && task === _getSelectedTask()) {
        const range = document.getElementById('reels-bg-volume-range');
        const num = document.getElementById('reels-bg-volume-num');
        const isCustom = range?.dataset?.isCustom === 'true' || num?.dataset?.isCustom === 'true';
        const uiValue = parseFloat((num && num.value !== '') ? num.value : (range || {}).value);
        if (isCustom && Number.isFinite(uiValue)) {
            return Math.max(0, globalBgVolume) * Math.max(0, uiValue) / 100;
        }
    }

    return Math.max(0, globalBgVolume);
}

function _updateBgVolumeConsistencyHint() {
    const hint = document.getElementById('reels-bg-volume-consistency-hint');
    if (!hint) return;
    const tasks = Array.isArray(window._reelsState?.tasks) ? window._reelsState.tasks : [];
    if (tasks.length === 0) {
        hint.style.display = 'none';
        return;
    }
    const globalVolume = _getGlobalBgVolumePercent();
    const rows = tasks.map((task, index) => {
        const multiplier = task?.bgVideoVolume != null && Number.isFinite(parseFloat(task.bgVideoVolume))
            ? Math.max(0, parseFloat(task.bgVideoVolume)) : 100;
        return { index: index + 1, multiplier, final: globalVolume * multiplier / 100 };
    });
    const uniqueFinals = new Set(rows.map(row => Math.round(row.final * 1000) / 1000));
    const customRows = rows.filter(row => Math.abs(row.multiplier - 100) > 0.001);
    hint.style.display = 'block';
    const baseStyle = 'display:block;margin:5px 0;padding:7px 10px;border-radius:6px;font-size:11px;line-height:1.45;';
    if (uniqueFinals.size > 1) {
        const examples = rows.slice(0, 6).map(row => `#${row.index}: ${globalVolume}%×${row.multiplier}%=${Math.round(row.final * 10) / 10}%`).join('；');
        hint.style.cssText = baseStyle + 'background:rgba(255,159,67,.12);border:1px solid rgba(255,159,67,.42);color:#ffd8a8;';
        hint.innerHTML = `⚠️ <strong>各任务最终背景音量不一致</strong>。${examples}${rows.length > 6 ? '；…' : ''}<br>检查方法：打开批量表格的“背景音量倍率”列；如果本应一致，点击列头“清”，将任务倍率统一恢复为 100%。`;
    } else if (customRows.length > 0) {
        hint.style.cssText = baseStyle + 'background:rgba(81,207,102,.10);border:1px solid rgba(81,207,102,.32);color:#b2f2bb;';
        hint.textContent = `✓ ${customRows.length} 个任务设置了自定义倍率，但当前最终背景音量一致为 ${Math.round(rows[0].final * 10) / 10}%。`;
    } else {
        hint.style.cssText = baseStyle + 'background:rgba(96,165,250,.08);border:1px solid rgba(96,165,250,.24);color:#bfdbfe;';
        hint.textContent = `✓ 所有任务均使用 100% 任务倍率，最终背景音量一致为 ${Math.round(globalVolume * 10) / 10}%。`;
    }
}
window._updateBgVolumeConsistencyHint = _updateBgVolumeConsistencyHint;

function _getEffectiveVoiceVolumePercent(task, globalVoiceVolume = _getGlobalVoiceVolumePercent()) {
    const raw = task && task.voiceVolume != null ? parseFloat(task.voiceVolume) : NaN;
    if (Number.isFinite(raw)) return Math.max(0, globalVoiceVolume) * Math.max(0, raw) / 100;
    return Math.max(0, globalVoiceVolume);
}

function _getEffectiveBgmVolumePercent(task, globalBgmVolume = _getGlobalBgmVolumePercent()) {
    const raw = task && task.bgmVolume != null ? parseFloat(task.bgmVolume) : NaN;
    if (Number.isFinite(raw)) return Math.max(0, globalBgmVolume) * Math.max(0, raw) / 100;

    if (task && task === _getSelectedTask()) {
        const range = document.getElementById('reels-bgm-task-volume-range');
        const num = document.getElementById('reels-bgm-task-volume-num');
        const isCustom = range?.dataset?.isCustom === 'true' || num?.dataset?.isCustom === 'true';
        const uiValue = parseFloat((num && num.value !== '') ? num.value : (range || {}).value);
        if (isCustom && Number.isFinite(uiValue)) {
            return Math.max(0, globalBgmVolume) * Math.max(0, uiValue) / 100;
        }
    }

    return Math.max(0, globalBgmVolume);
}

function _applyPreviewAudioMix() {
    // ── 确保 Web Audio 拓扑建立 ──
    _setupPreviewReverb();

    const ctx = _reelsState._audioCtx;
    if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(e => {});
    }
    const useWebAudio = !!(ctx && _reelsState._gainNodes);

    const task = _getSelectedTask();
    const audio = document.getElementById('reels-preview-audio');
    const video = document.getElementById('reels-preview-video');
    const contentVideoEl = document.getElementById('reels-preview-contentvideo');
    const cfg = _getPreviewAudioMixConfig();
    const hasVoice = !!(task && task.audioPath && audio && audio.src);
    // ── 计算有效音量：全局导出音量作为总控，任务级音量作为单任务微调 ──
    const effectiveVoiceGain = _getEffectiveVoiceVolumePercent(task, cfg.voiceGain * 100) / 100;
    const effectiveBgGain = _getEffectiveBgVolumePercent(task, cfg.bgGain * 100) / 100;

    if (audio) {
        const vol = hasVoice ? effectiveVoiceGain : 1.0;
        const isRouted = useWebAudio && _reelsState._mediaSources.has(audio) && _reelsState._gainNodes.has(audio);
        if (isRouted) {
            const gainNode = _reelsState._gainNodes.get(audio);
            gainNode.gain.setValueAtTime(vol, ctx.currentTime);
            audio.volume = vol > 0 ? 1.0 : 0;
            audio.muted = vol <= 0.001;
        } else {
            audio.volume = Math.min(1.0, vol);
            audio.muted = hasVoice ? (vol <= 0.001) : false;
        }
    }
    const players = [video, _reelsState.previewFadeVideo].filter(Boolean);
    for (const p of players) {
        const vol = effectiveBgGain;
        const isRouted = useWebAudio && _reelsState._mediaSources.has(p) && _reelsState._gainNodes.has(p);
        if (isRouted) {
            const gainNode = _reelsState._gainNodes.get(p);
            gainNode.gain.setValueAtTime(vol, ctx.currentTime);
            p.volume = vol > 0 ? 1.0 : 0;
            p.muted = vol <= 0.001;
        } else {
            p.volume = Math.min(1.0, vol);
            p.muted = vol <= 0.001;
        }
    }

    // ── 覆层视频 (Content Video) 音量 ──
    if (contentVideoEl && task) {
        const cvVolRaw = task.contentVideoVolume != null ? task.contentVideoVolume : 100;
        const cvVol = Math.max(0, cvVolRaw / 100); // 允许无上限
        const isRouted = useWebAudio && _reelsState._mediaSources.has(contentVideoEl) && _reelsState._gainNodes.has(contentVideoEl);
        if (isRouted) {
            const gainNode = _reelsState._gainNodes.get(contentVideoEl);
            gainNode.gain.setValueAtTime(cvVol, ctx.currentTime);
            contentVideoEl.volume = cvVol > 0 ? 1.0 : 0;
            contentVideoEl.muted = cvVol <= 0.001;
        } else {
            contentVideoEl.volume = Math.min(1.0, cvVol);
            contentVideoEl.muted = cvVol <= 0.001;
        }
    }

    // ── BGM 音量 ──
    const bgmAudio = _reelsState._bgmAudioEl;
    if (bgmAudio) {
        const finalBgmPath = task ? _getEffectiveBgmPath(task, _reelsState.selectedIdx) : '';
        if (finalBgmPath && bgmAudio.src) {
            const bgmVol = _getEffectiveBgmVolumePercent(task, cfg.bgmGain * 100) / 100;
            const isRouted = useWebAudio && _reelsState._mediaSources.has(bgmAudio) && _reelsState._gainNodes.has(bgmAudio);
            if (isRouted) {
                const gainNode = _reelsState._gainNodes.get(bgmAudio);
                gainNode.gain.setValueAtTime(bgmVol, ctx.currentTime);
                bgmAudio.volume = bgmVol > 0 ? 1.0 : 0;
                bgmAudio.muted = bgmVol <= 0.001;
            } else {
                bgmAudio.volume = Math.max(0, Math.min(1.0, bgmVol));
                bgmAudio.muted = bgmVol <= 0.001;
            }
        } else {
            const isRouted = useWebAudio && _reelsState._mediaSources.has(bgmAudio) && _reelsState._gainNodes.has(bgmAudio);
            if (isRouted) {
                const gainNode = _reelsState._gainNodes.get(bgmAudio);
                gainNode.gain.setValueAtTime(0, ctx.currentTime);
            }
            bgmAudio.volume = 0;
            bgmAudio.muted = true;
        }
    }

    // 外围表格和控件仍统一调用本函数；V2 开启时同步其独立媒体节点。
    window.ReelsPreviewV2?.syncAudio?.();
    _updateBgVolumeConsistencyHint();
}

// ═══════════════════════════════════════════════════════
// 预览音频混响 + 立体声增强 (Web Audio API)
// ═══════════════════════════════════════════════════════

const _REVERB_PRESETS = {
    room:   { decay: 0.8, duration: 0.6, density: 3000, lpFreq: 8000 },
    hall:   { decay: 2.0, duration: 1.5, density: 5000, lpFreq: 6000 },
    church: { decay: 4.0, duration: 3.0, density: 8000, lpFreq: 4000 },
    plate:  { decay: 1.2, duration: 1.0, density: 6000, lpFreq: 10000 },
    echo:   { decay: 1.5, duration: 0.8, density: 1500, lpFreq: 5000 },
};

// 确定性伪随机数生成器（mulberry32），保证相同preset的IR在预览和导出中一致
function _mulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// 将 preset 名字转为固定种子
function _presetSeed(preset) {
    let h = 0x811c9dc5;
    for (let i = 0; i < preset.length; i++) {
        h ^= preset.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function _generateImpulseResponse(ctx, preset) {
    const p = _REVERB_PRESETS[preset] || _REVERB_PRESETS.hall;
    const presetKey = preset || 'hall';
    const sampleRate = ctx.sampleRate;
    const length = Math.ceil(sampleRate * p.duration);
    const buffer = ctx.createBuffer(2, length, sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        // 每个声道用不同的种子，但同一 preset 始终相同
        const rng = _mulberry32(_presetSeed(presetKey) + ch * 0xDEAD);
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const envelope = Math.exp(-t / (p.decay * 0.3));
            data[i] = (rng() * 2 - 1) * envelope;
        }
    }
    return buffer;
}

function _setupPreviewReverb() {
    const audio = document.getElementById('reels-preview-audio');
    const video = document.getElementById('reels-preview-video');
    const contentVideoEl = document.getElementById('reels-preview-contentvideo');
    const bgm = _reelsState._bgmAudioEl;
    if (!audio && !video && !contentVideoEl && !bgm) return;

    const enabled = document.getElementById('reels-reverb-enabled')?.checked || false;
    const targetFx = document.getElementById('reels-audio-fx-target')?.value || 'all';
    const stereoWidth = (parseFloat(document.getElementById('reels-stereo-width')?.value) || 100) / 100;
    const mix = (parseFloat(document.getElementById('reels-reverb-mix')?.value) || 30) / 100;
    const needsFx = enabled || (stereoWidth > 1.05);

    // Initialize AudioContext and mediaSources Map if not present
    if (!_reelsState._audioCtx) {
        try {
            _reelsState._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('[Reverb] Web Audio not supported', e);
            return;
        }
    }
    if (!_reelsState._mediaSources) _reelsState._mediaSources = new Map();
    if (!_reelsState._gainNodes) _reelsState._gainNodes = new Map();
    const ctx = _reelsState._audioCtx;

    // Attach MediaElementSource for any new elements
    const fadeVideo = _reelsState.previewFadeVideo;
    const els = [audio, video, fadeVideo, contentVideoEl, bgm].filter(Boolean);
    for (const el of els) {
        if (!_reelsState._mediaSources.has(el)) {
            try {
                const source = ctx.createMediaElementSource(el);
                _reelsState._mediaSources.set(el, source);
            } catch (e) {
                console.warn('[Reverb] Failed to create source for', el, e);
            }
        }
        if (!_reelsState._gainNodes.has(el)) {
            try {
                const gainNode = ctx.createGain();
                gainNode.gain.setValueAtTime(1.0, ctx.currentTime);
                _reelsState._gainNodes.set(el, gainNode);
            } catch (e) {
                console.warn('[Reverb] Failed to create gain node for', el, e);
            }
        }
    }

    // Disconnect everything fully before rewiring
    for (const source of _reelsState._mediaSources.values()) {
        try { source.disconnect(); } catch (e) { }
    }
    for (const gainNode of _reelsState._gainNodes.values()) {
        try { gainNode.disconnect(); } catch (e) { }
    }
    if (_reelsState._reverbGainWet) { try { _reelsState._reverbGainWet.disconnect(); } catch(e){} }
    if (_reelsState._reverbGainDry) { try { _reelsState._reverbGainDry.disconnect(); } catch(e){} }
    if (_reelsState._convolver) { try { _reelsState._convolver.disconnect(); } catch(e){} }
    if (_reelsState._stereoDelay) {
        try {
            _reelsState._stereoDelay.masterGain.disconnect();
            _reelsState._stereoDelay.splitter.disconnect();
            _reelsState._stereoDelay.delayL.disconnect();
            _reelsState._stereoDelay.delayR.disconnect();
            _reelsState._stereoDelay.merger.disconnect();
        } catch (e) {}
    }

    // Wire each source node to its corresponding Volume GainNode
    for (const [el, source] of _reelsState._mediaSources.entries()) {
        const gainNode = _reelsState._gainNodes.get(el);
        if (gainNode) {
            source.connect(gainNode);
        }
    }

    // Determine target element for FX
    let targetEl = null;
    let targetGainNode = null;
    
    if (needsFx) {
        if ((targetFx === 'voice' || targetFx === 'all') && audio?.src) targetEl = audio;
        else if ((targetFx === 'bg' || targetFx === 'all') && video?.src) targetEl = video;
        else if ((targetFx === 'bgm' || targetFx === 'all') && bgm?.src) targetEl = bgm;
        // Fallback cascade
        if (!targetEl) {
            if (audio?.src) targetEl = audio;
            else if (video?.src) targetEl = video;
            else if (bgm?.src) targetEl = bgm;
        }
        if (targetEl) targetGainNode = _reelsState._gainNodes.get(targetEl);
    }

    // Connect non-target GainNodes directly to destination
    for (const [el, gainNode] of _reelsState._gainNodes.entries()) {
        if (gainNode && el !== targetEl) {
            gainNode.connect(ctx.destination);
        }
    }

    // If no FX or no target gain node, target gain node also connects directly to destination
    if (!needsFx || !targetGainNode) {
        if (targetGainNode) targetGainNode.connect(ctx.destination);
        return;
    }

    // --- Build FX Chain for target ---
    const preset = document.getElementById('reels-reverb-preset')?.value || 'hall';

    // Dry Gain
    const dryGain = ctx.createGain();
    dryGain.gain.value = enabled ? (1 - mix * 0.5) : 1.0; 

    // Wet Gain (Reverb)
    let convolver = null;
    let wetGain = null;
    if (enabled) {
        convolver = ctx.createConvolver();
        convolver.buffer = _generateImpulseResponse(ctx, preset);
        wetGain = ctx.createGain();
        wetGain.gain.value = mix;
    }

    const masterGain = ctx.createGain();
    masterGain.gain.value = 1.0;
    masterGain.channelCount = 2;
    masterGain.channelCountMode = 'explicit';

    targetGainNode.connect(dryGain);
    dryGain.connect(masterGain);

    if (enabled) {
        targetGainNode.connect(convolver);
        convolver.connect(wetGain);
        wetGain.connect(masterGain);
    }

    // Stereo Expansion
    if (stereoWidth > 1.05) {
        const merger = ctx.createChannelMerger(2);
        const splitter = ctx.createChannelSplitter(2);
        const delayL = ctx.createDelay(0.05);
        const delayR = ctx.createDelay(0.05);
        const widthFactor = Math.max(0, (stereoWidth - 1)) * 0.015; 
        delayL.delayTime.value = widthFactor * 0.3;
        delayR.delayTime.value = widthFactor * 0.7;

        masterGain.connect(splitter);
        splitter.connect(delayL, 0);
        splitter.connect(delayR, 1);
        delayL.connect(merger, 0, 0);
        delayR.connect(merger, 0, 1);
        merger.connect(ctx.destination);

        _reelsState._stereoDelay = { delayL, delayR, splitter, merger, masterGain };
    } else {
        masterGain.connect(ctx.destination);
        _reelsState._stereoDelay = null;
    }

    // Save refs
    _reelsState._convolver = convolver;
    _reelsState._reverbGainWet = wetGain;
    _reelsState._reverbGainDry = dryGain;
}

function _getReverbConfig() {
    return {
        enabled: document.getElementById('reels-reverb-enabled')?.checked || false,
        preset: document.getElementById('reels-reverb-preset')?.value || 'hall',
        mix: parseFloat(document.getElementById('reels-reverb-mix')?.value || '30'),
        stereoWidth: parseFloat(document.getElementById('reels-stereo-width')?.value || '100'),
        audioFxTarget: document.getElementById('reels-audio-fx-target')?.value || 'all',
    };
}

function _resetPreviewFadeVideo() {
    const fadeVideo = _reelsState.previewFadeVideo;
    if (!fadeVideo) return;
    fadeVideo.pause();
    fadeVideo.removeAttribute('src');
    _reelsState.previewFadeVideoSrc = '';
}

function _ensurePreviewFadeVideo(mainVideo) {
    if (!mainVideo) return null;
    const task = _getSelectedTask();
    const isMulti = task && task.bgMode === 'multi';
    if (!isMulti && !mainVideo.src) return null;

    if (!_reelsState.previewFadeVideo) {
        const fadeVideo = document.createElement('video');
        fadeVideo.id = 'reels-preview-video-fade';
        fadeVideo.muted = true;
        fadeVideo.loop = true;
        fadeVideo.playsInline = true;
        fadeVideo.preload = 'auto';
        const host = document.getElementById('reels-preview-container') || document.body;
        host.appendChild(fadeVideo);
        _ensurePreviewVideoDecodable(fadeVideo);
        _reelsState.previewFadeVideo = fadeVideo;
        _applyPreviewAudioMix();
    }

    const fadeVideo = _reelsState.previewFadeVideo;
    if (!isMulti && _reelsState.previewFadeVideoSrc !== mainVideo.src) {
        fadeVideo.pause();
        fadeVideo.src = mainVideo.src;
        _reelsState.previewFadeVideoSrc = mainVideo.src;
    }
    return fadeVideo;
}

function _calcPreviewLoopFadeFrame() {
    const task = _getSelectedTask();
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    if (!task || !video || !video.src || video.readyState < 2) return null;
    if (task.bgMode === 'multi') return null;
    if (!task.audioPath || _isImagePath(task.bgPath || task.videoPath)) return null;

    const cfg = _getPreviewLoopFadeConfig();
    const vDur = _getVideoDuration(task);
    if (!cfg.enabled || !(vDur > 0)) return null;

    const fadeDur = Math.min(cfg.duration, Math.max(0.1, vDur * 0.45));
    if (!(vDur > fadeDur + 0.05)) return null;

    const masterTime = _getPreviewCurrentTime();
    if (!Number.isFinite(masterTime) || masterTime < 0) return null;

    // ── 智能避让：预览接近结尾时压制转场，避免最终帧是半透明重叠 ──
    const totalDur = _getPreviewDuration();
    if (totalDur > 0 && (totalDur - masterTime) < fadeDur) {
        // 接近结束，不绘制交叉淡化
        return null;
    }

    const loopTime = ((masterTime % vDur) + vDur) % vDur;
    const remain = vDur - loopTime;
    if (!(remain < fadeDur)) return null;

    const fadeVideo = _ensurePreviewFadeVideo(video);
    if (!fadeVideo) return null;

    const target = (loopTime + fadeDur) % vDur;
    if (Math.abs((fadeVideo.currentTime || 0) - target) > 0.08) {
        try { fadeVideo.currentTime = target; } catch (e) { }
    }
    if (audio && !audio.paused && fadeVideo.paused) {
        fadeVideo.play().catch(() => { });
    }

    const alpha = Math.max(0, Math.min(1, (fadeDur - remain) / fadeDur));
    if (!(alpha > 0.001)) return null;
    return { video: fadeVideo, alpha };
}

function _syncBackgroundVideoToMaster() {
    const task = _getSelectedTask();
    if (!task) return;

    // Skip sync during hook or cover phase (hook video renders separately, cover is static)
    if (_reelsState.hookPhase || _reelsState.coverPhase) return;

    let masterTime = _getPreviewCurrentTime();
    // Offset by hook + cover duration so content time is relative to main phase start
    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const offsetDur = hookDur + coverDur;
    if (offsetDur > 0) masterTime = Math.max(0, masterTime - offsetDur);
    if (!isFinite(masterTime) || masterTime < 0) return;

    // --- Sync Content Video ---
    const contentVideoEl = document.getElementById('reels-preview-contentvideo');
    const master = _getPreviewMasterElement();
    if (contentVideoEl && contentVideoEl.src && contentVideoEl.readyState >= 1) {
        if (contentVideoEl !== master) {
            if (contentVideoEl.duration > 0) {
                const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
                const trimEnd = parseFloat(task.contentVideoTrimEnd) || 0;
                let cvDur = contentVideoEl.duration;
                if (trimEnd > trimStart && trimStart >= 0) {
                    cvDur = Math.max(0.1, trimEnd - trimStart);
                } else if (trimStart > 0) {
                    cvDur = Math.max(0.1, contentVideoEl.duration - trimStart);
                }
                const target = (masterTime % cvDur) + trimStart;
                if (!contentVideoEl.seeking && Math.abs((contentVideoEl.currentTime || 0) - target) > 0.25) {
                    try { contentVideoEl.currentTime = target; } catch (e) { }
                }
                const isPlaying = _isPreviewMediaPlaying(master) || !!_reelsState.mockPlaying;
                if (isPlaying && contentVideoEl.paused) {
                    contentVideoEl.play().catch(() => { });
                } else if (!isPlaying && !contentVideoEl.paused) {
                    contentVideoEl.pause();
                }
            }
        }
    }

    // --- Sync Background Video ---
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    if (task.contentVideoDirectBg && task.contentVideoPath) {
        if (video && !video.paused) video.pause();
        if (_reelsState.previewFadeVideo && !_reelsState.previewFadeVideo.paused) _reelsState.previewFadeVideo.pause();
        return;
    }
    if (task.bgMode === 'multi') return;
    if (!video || !video.src || video.readyState < 1 || _isImagePath(task.bgPath || task.videoPath)) return;
    const vDur = _getVideoDuration(task);
    if (vDur > 0) {
        const target = masterTime % vDur;
        if (!video.seeking && Math.abs((video.currentTime || 0) - target) > 0.25) {
            try { video.currentTime = target; } catch (e) { }
        }
        // 某些容器在 ended 后会暂停，手动拉起继续播，保证背景持续循环。
        if (audio && !audio.paused && video.paused) {
            video.play().catch(() => { });
        }

        const cfg = _getPreviewLoopFadeConfig();
        if (task.audioPath && cfg.enabled && vDur > cfg.duration + 0.05) {
            const fadeVideo = _ensurePreviewFadeVideo(video);
            if (fadeVideo) {
                const fadeDur = Math.min(cfg.duration, Math.max(0.1, vDur * 0.45));
                const fadeTarget = (target + fadeDur) % vDur;
                if (!fadeVideo.seeking && Math.abs((fadeVideo.currentTime || 0) - fadeTarget) > 0.2) {
                    try { fadeVideo.currentTime = fadeTarget; } catch (e) { }
                }
                if (audio && !audio.paused && fadeVideo.paused) {
                    fadeVideo.play().catch(() => { });
                }
            }
        } else if (_reelsState.previewFadeVideo) {
            _reelsState.previewFadeVideo.pause();
        }
    }
}

function _updatePreviewTimeUI(currentTime, duration) {
    const seekBar = document.getElementById('reels-preview-seek');
    if (seekBar && !seekBar._hasBoundSeekbarEvents) {
        seekBar._hasBoundSeekbarEvents = true;
        
        const startScrubbing = () => { window._isScrubbingSeekbar = true; };
        const stopScrubbing = () => { window._isScrubbingSeekbar = false; };
        
        seekBar.addEventListener('pointerdown', startScrubbing);
        seekBar.addEventListener('mousedown', startScrubbing);
        seekBar.addEventListener('touchstart', startScrubbing);
        
        seekBar.addEventListener('pointerup', stopScrubbing);
        seekBar.addEventListener('pointercancel', stopScrubbing);
        seekBar.addEventListener('mouseup', stopScrubbing);
        seekBar.addEventListener('touchend', stopScrubbing);
        seekBar.addEventListener('change', stopScrubbing);
        
        window.addEventListener('pointerup', stopScrubbing);
        window.addEventListener('mouseup', stopScrubbing);
        window.addEventListener('touchend', stopScrubbing);
    }
    const timeLabel = document.getElementById('reels-preview-time');
    if (seekBar && duration > 0 && !window._isScrubbingSeekbar) {
        seekBar.value = Math.max(0, Math.min(100, (currentTime / duration) * 100));
    }
    if (timeLabel) {
        const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        timeLabel.textContent = `${fmt(currentTime || 0)}/${fmt(duration || 0)}`;
    }
}

function _updateTimelineForTask(task) {
    if (!_reelsState.timelineEditor || !task) return;
    const editor = _reelsState.timelineEditor;
    if (window.ReelsRenderPlan) {
        const subtitleDuration = Array.isArray(task.segments) && task.segments.length
            ? Math.max(...task.segments.map(segment => Number(segment.end) || 0))
            : 0;
        // 背景轨必须显示真实的“循环实例”，不能把一段 5 秒背景循环 20 秒
        // 伪装成一个大块。多素材时复用预览的同一分段算法；单素材循环时按
        // 原始媒体时长平铺成 #1/#2/#3…，最后一轮按成片终点截短。
        let backgroundSegments = task.bgMode === 'multi' && typeof _calculatePreviewSegments === 'function'
            ? _calculatePreviewSegments(task)
            : [];
        if (!backgroundSegments.length) {
            const resolvedBackground = typeof _resolvePreviewBackgroundPath === 'function'
                ? _resolvePreviewBackgroundPath(task)
                : { path: task.bgPath || task.videoPath || '' };
            const backgroundPath = resolvedBackground?.path || task.bgPath || task.videoPath || '';
            const rawBackgroundDuration = _getVideoDuration(task);
            const outputDuration = Math.max(subtitleDuration, _getAudioDuration(task), _getContentVideoDuration(task), Number(task.duration) || 0, task.customDuration || 0, rawBackgroundDuration || 0, 1);
            if (backgroundPath) {
                const loopDuration = rawBackgroundDuration > 0.05 ? rawBackgroundDuration : outputDuration;
                for (let start = 0, index = 0; start < outputDuration - 0.001; start += loopDuration, index++) {
                    const end = Math.min(outputDuration, start + loopDuration);
                    backgroundSegments.push({
                        path: backgroundPath,
                        start,
                        end,
                        duration: end - start,
                        trimStart: 0,
                        speedFactor: 1,
                        loopIndex: index,
                    });
                }
            }
        }
        const tracks = window.ReelsRenderPlan.getEditorTracks(task, {
            // 媒体元数据还没读到时，字幕末尾仍能给出可靠的整片长度，避免
            // 主视频/人声在时间线中退化为 0 秒的细竖条。
            duration: Math.max(_getAudioDuration(task), _getVideoDuration(task), _getContentVideoDuration(task), Number(task.duration) || 0, subtitleDuration, task.customDuration || 0, 1),
            width: _reelsState.targetWidth || 1080,
            height: _reelsState.targetHeight || 1920,
            backgroundSegments,
        });
        if (tracks.length) editor.setTracks(tracks);
    }
    editor.subtitleBaseStyle = _resolveSubtitleStyleForTask(task);
    if (!window.ReelsRenderPlan) {
        if (task.segments && task.segments.length > 0) editor.loadSubtitleTrack(task.segments);
        else editor.loadSubtitleTrack([]);
    }

    const aDur = _getAudioDuration(task);
    const vDur = _getVideoDuration(task);
    const cvDur = _getContentVideoDuration(task);
    const subDur = task.segments && task.segments.length > 0
        ? (task.segments[task.segments.length - 1].end || 0)
        : 0;
    let contentDur = Math.max(aDur, vDur, cvDur, Number(task.duration) || 0, subDur, 1);
    if (task.customDuration && task.customDuration > 0) {
        contentDur = Math.max(contentDur, task.customDuration);
    }
    // V2 与时间线使用相同的时长来源：它已包含配音/背景变速、多背景、
    // 自定义时长和动态覆层等规则；时间线仍显示主内容时长（不含封面/Hook 偏移）。
    const totalDur = window.ReelsPreviewV2?.isOpen?.()
        ? window.ReelsPreviewV2.getTimelineDuration()
        : contentDur;
    const taskKey = task.id || task.fileName || task.audioPath || task.bgPath || '';
    const isNewTimelineTask = editor._timelineTaskKey !== taskKey;
    if (!window.ReelsRenderPlan) editor.loadAudioTrack(aDur, task.audioPath ? '人声' : '音频');
    // 背景在预览/输出中会循环覆盖整段内容，轨道也应显示实际覆盖时长，
    // 不能在无配音时退回到单个背景素材的原始时长。
    const bgTrackDur = totalDur;
    const bgTrackName = task.contentVideoDirectBg ? '内容背景' : (totalDur > vDur + 0.01 ? '背景(循环)' : '背景');
    if (!window.ReelsRenderPlan) editor.loadBackgroundTrack(bgTrackDur, bgTrackName);
    editor.setDuration(totalDur, { fit: isNewTimelineTask });
    editor._timelineTaskKey = taskKey;
}

function _buildAudioSubtitleMatchKey(name) {
    const normalized = _normalizeBaseName(name).replace(/[\u2013\u2014]/g, '-');
    const tokens = normalized
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .filter(t => !REELS_MATCH_STOPWORDS.has(t));
    return tokens.join('_') || normalized;
}
window._buildAudioSubtitleMatchKey = _buildAudioSubtitleMatchKey;

function _inferTaskBaseName(task) {
    const src = task.baseName || task.fileName || task.audioPath || task.bgPath || task.videoPath || task.srtPath || '';
    const fileName = String(src).split(/[\\/]/).pop();
    return _normalizeBaseName(fileName);
}

function _getOrCreateTaskByBase(baseName, fallbackName = '') {
    const normalized = _normalizeBaseName(baseName || fallbackName);
    let task = _reelsState.tasks.find(t => _inferTaskBaseName(t) === normalized);
    if (task) return task;

    task = {
        id: 'task_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
        importedAt: Date.now(),
        baseName: normalized,
        fileName: fallbackName || `${normalized || 'reel'}.mp4`,
        bgPath: null,
        bgSrcUrl: null,
        audioPath: null,
        srtPath: null,
        segments: [],
        // 兼容旧字段
        videoPath: null,
        srcUrl: null,
    };
    _reelsState.tasks.push(task);
    return task;
}

async function reelsCreateTaskFromAutoEditResult(autoEditResult = {}, opts = {}) {
    const videoPath = autoEditResult.output_path || autoEditResult.outputPath || '';
    const srtPath = autoEditResult.srt_path || autoEditResult.srtPath || '';
    if (!videoPath) throw new Error('缺少自动剪辑输出视频');
    if (!srtPath) throw new Error('缺少自动剪辑输出字幕');

    const baseName = _normalizeBaseName(
        opts.baseName ||
        String(videoPath).split(/[\\/]/).pop().replace(/\.[^.]+$/, '') ||
        'auto_edit'
    );
    const task = (typeof _createEmptyTask === 'function') ? _createEmptyTask() : {
        id: 'task_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
        bgPath: null,
        bgSrcUrl: null,
        audioPath: null,
        srtPath: null,
        segments: [],
        videoPath: null,
        srcUrl: null,
    };

    task.baseName = baseName || 'auto_edit';
    if (!Number.isFinite(Number(task.importedAt))) task.importedAt = Date.now();
    task.fileName = `${task.baseName}.mp4`;
    task.audioPath = null;
    task.srtPath = srtPath;
    task.aligned = true;
    task.alignSource = 'auto_edit';
    task._autoEditSource = true;
    // 这份来源快照与 Reels 的二剪工程一同保存。它既指向自动剪辑分析工程，
    // 也保留原片、目标文案和审核切点；清空 Reels 队列后仍可回溯整个过程。
    task.autoEditProject = {
        version: 1,
        analysisProjectPath: autoEditResult.project_path || autoEditResult.projectPath || '',
        analysisReportPath: autoEditResult.report_path || autoEditResult.reportPath || '',
        analysisOutputDir: autoEditResult.output_dir || autoEditResult.outputDir || '',
        outputPath: videoPath,
        srtPath,
        outputDir: autoEditResult.output_dir || autoEditResult.outputDir || '',
        processedClipsDir: autoEditResult.processed_clips_dir || autoEditResult.processedClipsDir || '',
        processedClips: Array.isArray(autoEditResult.processed_clips) ? autoEditResult.processed_clips : [],
        originalClips: Array.isArray(autoEditResult.clips) ? [...autoEditResult.clips] : [],
        scriptText: autoEditResult.script_text || autoEditResult.scriptText || '',
        reviewSegments: Array.isArray(autoEditResult.review_segments)
            ? autoEditResult.review_segments
            : (Array.isArray(autoEditResult.segments) ? autoEditResult.segments : []),
        savedAt: new Date().toISOString(),
    };
    // 自动剪辑送入 Reels 的成片就是唯一画面源。即使空任务构造器以后带上
    // 模板默认值，也不能让旧的内容视频/插入素材在导出时再叠一层画面。
    task.contentVideoPath = '';
    task.contentVideoDirectBg = false;
    task.contentVideoBlurBg = false;
    task.insertClips = [];
    task.overlays = [];
    task.visualOverlayOrder = [];

    if (typeof _setTaskSingleBackground === 'function') {
        _setTaskSingleBackground(task, videoPath, { clearBgSrcUrl: true });
    } else {
        task.bgPath = videoPath;
        task.videoPath = videoPath;
        task.bgSrcUrl = null;
        task.srcUrl = null;
    }

    // 自动剪辑的导出视频才是这条 Reels 的权威时长。此前这里只带了 SRT，
    // 在媒体元数据异步返回前，时间线和导出会用“最后一条字幕结束时间”作
    // 为整片长度，导致末尾无字幕或字幕不完整时被严重截短。
    const resultDuration = Number(
        autoEditResult.output_duration ?? autoEditResult.outputDuration ??
        autoEditResult.video_duration ?? autoEditResult.videoDuration ??
        autoEditResult.media_duration ?? autoEditResult.mediaDuration ??
        autoEditResult.duration
    );
    let videoDuration = Number.isFinite(resultDuration) && resultDuration > 0 ? resultDuration : 0;
    if (!videoDuration && typeof window.electronAPI?.getMediaDuration === 'function') {
        try {
            videoDuration = Number(await window.electronAPI.getMediaDuration(videoPath)) || 0;
        } catch (error) {
            console.warn('[Reels] 无法读取自动剪辑导出视频时长，将等待后续媒体探测', error);
        }
    }
    if (videoDuration > 0) {
        task.duration = videoDuration;
        _reelsState._mediaDurations = _reelsState._mediaDurations || {};
        _reelsState._mediaDurations[videoPath] = videoDuration;
    }

    let srtContent = autoEditResult.srt_content || '';
    if (!srtContent && window.electronAPI?.readFileText) {
        srtContent = await window.electronAPI.readFileText(srtPath);
    }
    if (srtContent && typeof parseSRT === 'function') {
        const rawSegs = parseSRT(srtContent).map(seg => ({ ...seg, _timeUnit: 'sec' }));
        task.segments = window.ReelsSubtitleProcessor
            ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
            : rawSegs;
    } else if (Array.isArray(autoEditResult.segments)) {
        task.segments = autoEditResult.segments
            .filter(seg => seg && seg.script && Number.isFinite(Number(seg.duration)))
            .reduce((acc, seg, i) => {
                const start = acc.length ? acc[acc.length - 1].end : 0;
                const end = start + Math.max(0.001, Number(seg.duration));
                acc.push({ index: i + 1, start, end, text: seg.script, words: [] });
                return acc;
            }, []);
    }

    // 先记住接收前的状态。后续任何页面初始化/渲染错误都要回滚，
    // 避免批量接收失败后留下半条任务，重试时又不断重复。
    const previousTaskCount = _reelsState.tasks.length;
    const previousSelectedIdx = _reelsState.selectedIdx;
    const workMode = document.getElementById('reels-work-mode');
    const previousWorkMode = workMode?.value;
    let batchArchive = null;
    try {
        _reelsState.tasks.push(task);
        _reelsState.selectedIdx = _reelsState.tasks.length - 1;
        // Persist into the active batch tab before any table/list rerender. This
        // is essential when the current Reels queue is a multi-tab projection.
        batchArchive = window.reelsArchiveTaskToActiveBatchTab?.(task) || null;

        if (workMode) {
            workMode.value = 'voiced_bg';
            if (typeof reelsOnWorkModeChange === 'function') reelsOnWorkModeChange();
        }

        if (typeof _renderBatchTable === 'function') _renderBatchTable();
        if (typeof _renderTaskList === 'function') _renderTaskList();
        if (typeof reelsSelectTask === 'function') reelsSelectTask(_reelsState.selectedIdx);
        else if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();

        // 不依赖用户手动点“保存工程”：每次送入自动剪辑成片时，在成片旁生成
        // `<成片名>.reels-project.json`。随后即使点击清空任务，二剪工程仍在。
        const recovery = opts.skipRecoveryCollection ? null : await window.ReelsProject?.saveAutoEditRecoveryProject?.(_reelsState, task, autoEditResult);
        if (recovery?.ok) {
            task.autoEditProject.reelsProjectPath = recovery.path;
            task.autoEditProject.collectionPath = recovery.collection?.projectDir || '';
            batchArchive = window.reelsArchiveTaskToActiveBatchTab?.(task) || batchArchive;
            if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
            if (typeof showToast === 'function') {
                const label = recovery.collection?.ok
                    ? `${recovery.collection.projectDir.split(/[\\/]/).pop()}（已收集成片、字幕、工程和原片）`
                    : recovery.path.split(/[\\/]/).pop();
                const missingHint = recovery.collection?.ok && recovery.collection.complete === false
                    ? `；${recovery.collection.missing?.length || 0} 个文件未找到，详见工程清单`
                    : '';
                showToast(`已保存二剪工程：${label}${missingHint}`, recovery.collection?.ok && recovery.collection.complete !== false ? 'success' : 'warning', 7000);
            }
        } else if (!opts.skipRecoveryCollection) {
            console.warn('[Reels] 自动剪辑二剪工程保存失败，仍可使用“保存工程”手动保存');
        }
    } catch (error) {
        _reelsState.tasks.splice(previousTaskCount);
        _reelsState.selectedIdx = previousSelectedIdx;
        batchArchive?.rollback?.();
        if (workMode && previousWorkMode) workMode.value = previousWorkMode;
        throw error;
    }

    return task;
}
window.reelsCreateTaskFromAutoEditResult = reelsCreateTaskFromAutoEditResult;

// 自动剪辑二次导出时，不新建 Reels 任务：仅替换该任务的成片和 SRT，
// 所有用户在 Reels 内追加的覆层、贴纸、BGM、字幕样式与画面设置均保留。
async function reelsUpdateTaskFromAutoEditResult(autoEditResult = {}, opts = {}) {
    // 更新旧任务是显式操作。任何后台导出、自动恢复或列表重绘都不得调用
    // 这条路径覆盖现有 Reels 成片和字幕。
    if (opts.userInitiated !== true) throw new Error('旧 Reels 任务只能由用户手动更新');
    const videoPath = autoEditResult.output_path || autoEditResult.outputPath || '';
    const srtPath = autoEditResult.srt_path || autoEditResult.srtPath || '';
    if (!videoPath || !srtPath) throw new Error('缺少重新导出的自动剪辑成片或字幕');
    const taskId = String(opts.taskId || autoEditResult.reels_task_id || autoEditResult.reelsTaskId || '');
    const analysisPath = String(autoEditResult.project_path || autoEditResult.projectPath || '');
    const task = _reelsState.tasks.find(item => String(item.id) === taskId)
        || _reelsState.tasks.find(item => analysisPath && String(item.autoEditProject?.analysisProjectPath || '') === analysisPath);
    if (!task?.autoEditProject) throw new Error('未找到已关联的 Reels 自动剪辑任务');

    if (typeof _setTaskSingleBackground === 'function') _setTaskSingleBackground(task, videoPath, { clearBgSrcUrl: true });
    else { task.bgPath = videoPath; task.videoPath = videoPath; task.bgSrcUrl = null; task.srcUrl = null; }
    const preserveManualSubtitles = task._manualSubtitleEdits === true && opts.replaceSubtitles !== true;
    if (!preserveManualSubtitles) {
        task.srtPath = srtPath;
        task._manualSubtitleEdits = false;
    }
    task.aligned = true;
    task._autoEditSource = true;
    if (!preserveManualSubtitles) {
        let srtContent = autoEditResult.srt_content || '';
        if (!srtContent && window.electronAPI?.readFileText) srtContent = await window.electronAPI.readFileText(srtPath);
        if (srtContent && typeof parseSRT === 'function') {
            const raw = parseSRT(srtContent).map(segment => ({ ...segment, _timeUnit: 'sec' }));
            task.segments = window.ReelsSubtitleProcessor ? ReelsSubtitleProcessor.srtToSegmentsWithWords(raw) : raw;
        }
    } else {
        task.autoEditProject = { ...task.autoEditProject, pendingSrtPath: srtPath };
    }
    const duration = Number(autoEditResult.output_duration ?? autoEditResult.outputDuration ?? autoEditResult.duration)
        || Number(await window.electronAPI?.getMediaDuration?.(videoPath)) || 0;
    if (duration > 0) {
        task.duration = duration;
        _reelsState._mediaDurations = _reelsState._mediaDurations || {};
        _reelsState._mediaDurations[videoPath] = duration;
    }
    task.autoEditProject = {
        ...task.autoEditProject,
        outputPath: videoPath, srtPath: preserveManualSubtitles ? task.autoEditProject.srtPath : srtPath,
        latestAutoEditSrtPath: srtPath,
        analysisProjectPath: analysisPath || task.autoEditProject.analysisProjectPath,
        analysisReportPath: autoEditResult.report_path || autoEditResult.reportPath || task.autoEditProject.analysisReportPath,
        analysisOutputDir: autoEditResult.output_dir || autoEditResult.outputDir || task.autoEditProject.analysisOutputDir,
        reviewSegments: Array.isArray(autoEditResult.review_segments) ? autoEditResult.review_segments : task.autoEditProject.reviewSegments,
        updatedAt: new Date().toISOString(),
    };
    const index = _reelsState.tasks.indexOf(task);
    if (typeof _renderBatchTable === 'function') _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    if (typeof reelsSelectTask === 'function') reelsSelectTask(index);
    if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
    task._lastAutoEditSubtitlePreserved = preserveManualSubtitles;
    return task;
}
window.reelsUpdateTaskFromAutoEditResult = reelsUpdateTaskFromAutoEditResult;

async function reelsRefreshAutoEditTask(index) {
    const task = _reelsState.tasks[index];
    if (!task?.autoEditProject) return;
    try {
        const updated = await reelsUpdateTaskFromAutoEditResult({
            output_path: task.autoEditProject.outputPath || task.bgPath,
            srt_path: task.autoEditProject.srtPath || task.srtPath,
            project_path: task.autoEditProject.analysisProjectPath,
        }, { taskId: task.id, replaceSubtitles: true, userInitiated: true });
        showToast?.('已更新自动剪辑成片与最新字幕；Reels 覆层、贴纸、BGM 和字幕样式已保留', 'success');
    } catch (error) {
        showToast?.(`更新自动剪辑任务失败：${error.message || error}`, 'error');
    }
}
window.reelsRefreshAutoEditTask = reelsRefreshAutoEditTask;

function _buildFileInfo(file) {
    const name = file.name || '';
    // Electron 开启 contextIsolation 后，渲染世界里的 File 可能无法再被
    // webUtils 识别。任务列表拖拽会在 preload 捕获原始路径并挂到这里。
    let filePath = file._nativePath || name;
    
    // 1. 尝试 Electron API（最可靠）
    if (window.electronAPI && window.electronAPI.getFilePath) {
        try {
            const p = window.electronAPI.getFilePath(file);
            if (p) filePath = p;
            console.log(`[_buildFileInfo] electronAPI.getFilePath("${name}") → "${p}"`);
        } catch (e) {
            console.warn(`[_buildFileInfo] electronAPI.getFilePath error:`, e);
        }
    }
    
    // 2. 回退: file.path（旧 Electron / contextIsolation:false）
    if (filePath === name && file.path) {
        filePath = file.path;
        console.log(`[_buildFileInfo] fallback to file.path: "${filePath}"`);
    }
    
    // 3. 最终回退: 仅文件名
    if (filePath === name) {
        console.warn(`[_buildFileInfo] ⚠️ 无法获取完整路径，仅文件名: "${name}"`);
    }
    
    return {
        name,
        path: filePath,
        baseName: _normalizeBaseName(name),
        matchKey: _buildAudioSubtitleMatchKey(name),
    };
}

function _pushPendingUnique(list, item) {
    const key = item.path || item.name;
    const exists = list.some(x => (x.path || x.name) === key);
    if (!exists) list.push(item);
}

function _queueBackgroundFile(file, options = {}) {
    const info = _buildFileInfo(file);
    let srcUrl = null;
    if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function' && info.path) {
        srcUrl = window.electronAPI.toFileUrl(info.path);
    } else {
        try { srcUrl = URL.createObjectURL(file); } catch (e) { }
    }
    info.srcUrl = srcUrl;
    // 从左侧任务区直接投放多个背景时，用户期待“一条素材 = 一条任务”；
    // 菜单“导入背景素材”仍保持素材库语义，不额外制造空任务。
    info.createTask = options.createTask === true;
    _pushPendingUnique(_reelsState.pendingFiles.backgrounds, info);
}

function _upsertBackgroundLibrary(bg) {
    if (!bg || !bg.path) return;
    const idx = _reelsState.backgroundLibrary.findIndex(x => x.path === bg.path);
    if (idx >= 0) {
        _reelsState.backgroundLibrary[idx] = { ..._reelsState.backgroundLibrary[idx], ...bg };
    } else {
        _reelsState.backgroundLibrary.push({ ...bg });
    }
}

function _queueAudioFile(file) {
    const info = _buildFileInfo(file);
    _pushPendingUnique(_reelsState.pendingFiles.audios, info);
}

function _queueSrtFile(file) {
    const info = _buildFileInfo(file);
    const reader = new FileReader();
    reader.onload = (ev) => {
        info.content = ev.target.result;
        _pushPendingUnique(_reelsState.pendingFiles.srts, info);
        reelsAutoMatchFiles();
    };
    reader.readAsText(file);
}

function _queueTxtFile(file) {
    const info = _buildFileInfo(file);
    const reader = new FileReader();
    reader.onload = (ev) => {
        info.content = ev.target.result;
        _pushPendingUnique(_reelsState.pendingFiles.txts, info);
        reelsAutoMatchFiles();
    };
    reader.readAsText(file);
}

function _naturalCompareFileNames(a, b) {
    const extractBase = (item) => {
        if (item && typeof item === 'object') {
            const rawPath = item._nativePath || item.path || '';
            if (rawPath) {
                const base = String(rawPath).replace(/\\/g, '/').split('/').pop();
                if (base) return base;
            }
            if (item.name) return String(item.name);
            if (item.baseName) return String(item.baseName);
        }
        const s = String(item || '');
        return s.replace(/\\/g, '/').split('/').pop() || s;
    };
    const nameA = extractBase(a);
    const nameB = extractBase(b);
    const cmp = nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    if (cmp !== 0) return cmp;
    const fullA = String(a?._nativePath || a?.path || a?.name || a?.baseName || a || '');
    const fullB = String(b?._nativePath || b?.path || b?.name || b?.baseName || b || '');
    return fullA.localeCompare(fullB, undefined, { numeric: true, sensitivity: 'base' });
}

function _onTxtFilesSelected(e) {
    const files = Array.from(e.target.files || []).sort(_naturalCompareFileNames);
    for (const f of files) _queueTxtFile(f);
    e.target.value = '';
}

// 手动输入字幕弹窗
async function reelsManualSubtitleInput() {
    const result = await _showTextareaDialog(
        '✏️ 手动输入字幕文本',
        '每行 = 一条字幕段落（已断行的文本）\n支持多行，每行将作为独立字幕条目。',
        ''
    );
    if (!result || !result.trim()) return;

    // 视为一条 TXT 输入
    const info = {
        name: '_manual_input.txt',
        path: '_manual_input.txt',
        baseName: '_manual_input',
        matchKey: '',
        content: result,
    };
    _pushPendingUnique(_reelsState.pendingFiles.txts, info);
    reelsAutoMatchFiles();
}

// 通用 textarea 弹窗
function _showTextareaDialog(title, placeholder, defaultVal) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-secondary,#1e1e2e);border-radius:12px;padding:24px;width:520px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,0.5);';
        box.innerHTML = `
            <h3 style="margin:0 0 12px;font-size:16px;">${title}</h3>
            <textarea id="_reels_textarea_dlg" rows="10"
                style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--border-color,#444);
                       background:var(--bg-tertiary,#2a2a3e);color:var(--text-primary,#eee);
                       font-size:13px;resize:vertical;font-family:inherit;"
                placeholder="${placeholder}">${defaultVal || ''}</textarea>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
                <button class="btn btn-secondary" id="_reels_textarea_cancel">取消</button>
                <button class="btn btn-primary" id="_reels_textarea_ok">确认</button>
            </div>`;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const ta = box.querySelector('#_reels_textarea_dlg');
        const close = (val) => { document.body.removeChild(overlay); resolve(val); };
        box.querySelector('#_reels_textarea_cancel').onclick = () => close(null);
        box.querySelector('#_reels_textarea_ok').onclick = () => close(ta.value);
        overlay.onclick = (e) => { if (e.target === overlay) close(null); };
        setTimeout(() => ta.focus(), 50);
    });
}

// ═══════════════════════════════════════════════════════
// Subtitle alignment (call existing subtitle/generate API)
// ═══════════════════════════════════════════════════════

function reelsShowMismatchDialog(taskName, mismatchData, sourceText) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:99999;';

        const content = document.createElement('div');
        content.style.cssText = 'background:var(--bg-secondary,#1e1e2e);width:600px;max-width:90%;border-radius:12px;padding:24px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 10px 40px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:16px;font-family:system-ui,-apple-system,sans-serif;color:var(--text-primary,#eee);';

        const escapeHtml = (str) => {
            return String(str).replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match]));
        };

        content.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:24px;">⚠️</span>
                <h3 style="margin:0;color:var(--text-primary,#eee);font-size:18px;">文案匹配度警告 (匹配度: ${mismatchData.similarity}%)</h3>
            </div>
            <div style="font-size:14px;color:var(--text-secondary,#bbb);line-height:1.5;">
                任务 <b style="color:var(--text-primary,#eee);">${escapeHtml(taskName)}</b> 提取到的声音与您提供的参考文案差异极大。<br/>
                强行对齐将导致字幕时间轴严重错乱。
            </div>
            <div style="display:flex;gap:12px;margin-top:8px;">
                <div style="flex:1;background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.05);min-width:0;">
                    <div style="font-size:12px;color:var(--text-secondary,#bbb);margin-bottom:8px;font-weight:bold;">📝 您提供的原文案</div>
                    <div style="font-size:13px;color:var(--text-primary,#eee);max-height:150px;overflow-y:auto;line-height:1.5;white-space:pre-wrap;word-break:break-all;">${escapeHtml(sourceText || '')}</div>
                </div>
                <div style="flex:1;background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.05);min-width:0;">
                    <div style="font-size:12px;color:var(--text-secondary,#bbb);margin-bottom:8px;font-weight:bold;">🎙️ AI 实际识别到的声音</div>
                    <div style="font-size:13px;color:var(--text-primary,#eee);max-height:150px;overflow-y:auto;line-height:1.5;white-space:pre-wrap;word-break:break-all;">${escapeHtml(mismatchData.recognized_text || '')}</div>
                </div>
            </div>
            <div style="font-size:13px;color:var(--text-secondary,#bbb);margin-top:10px;">请选择如何处理此任务：</div>
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px;">
                <button id="reels-mismatch-btn-force" class="btn btn-secondary" style="flex:1;font-size:12px;padding:8px 12px;cursor:pointer;">⚠️ 强制使用原文案</button>
                <button id="reels-mismatch-btn-skip" class="btn btn-secondary" style="flex:1;font-size:12px;padding:8px 12px;cursor:pointer;">⏭️ 跳过此任务</button>
                <button id="reels-mismatch-btn-use" class="btn btn-primary" style="flex:1.5;background:var(--accent,#7b8bef);color:white;border:none;font-size:12px;padding:8px 12px;cursor:pointer;border-radius:6px;">🚀 使用识别文案 (推荐)</button>
            </div>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        const cleanup = () => document.body.removeChild(modal);

        modal.querySelector('#reels-mismatch-btn-force').addEventListener('click', () => { cleanup(); resolve('FORCE'); });
        modal.querySelector('#reels-mismatch-btn-skip').addEventListener('click', () => { cleanup(); resolve('SKIP'); });
        modal.querySelector('#reels-mismatch-btn-use').addEventListener('click', () => { cleanup(); resolve('USE_RECOGNIZED'); });
    });
}

function reelsShowAlignSummaryModal(results) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:99999;';

        const content = document.createElement('div');
        content.style.cssText = 'background:var(--bg-secondary,#1e1e2e);width:650px;max-width:90%;border-radius:12px;padding:24px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 10px 40px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:16px;font-family:system-ui,-apple-system,sans-serif;color:var(--text-primary,#eee);';

        const total = results.length;
        const okCount = results.filter(r => r.status !== 'SKIPPED' && r.status !== 'FAILED').length;
        const failCount = total - okCount;

        const escapeHtml = (str) => {
            return String(str).replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match]));
        };

        let rowsHtml = '';
        results.forEach((r, idx) => {
            let statusBadge = '';
            if (r.status === 'SUCCESS') statusBadge = '<span style="background:rgba(74,222,128,0.15);color:#4ade80;padding:2px 6px;border-radius:4px;font-size:11px;">✅ 对齐成功</span>';
            else if (r.status === 'FORCE') statusBadge = '<span style="background:rgba(251,191,36,0.15);color:#fbbf24;padding:2px 6px;border-radius:4px;font-size:11px;">⚠️ 强行对齐</span>';
            else if (r.status === 'CORRECTED') statusBadge = '<span style="background:rgba(96,165,250,0.15);color:#60a5fa;padding:2px 6px;border-radius:4px;font-size:11px;">🎙️ 自动修正</span>';
            else if (r.status === 'SKIPPED') statusBadge = '<span style="background:rgba(156,163,175,0.15);color:#9ca3af;padding:2px 6px;border-radius:4px;font-size:11px;">⏭️ 已跳过</span>';
            else statusBadge = `<span style="background:rgba(239,68,68,0.15);color:#ef4444;padding:2px 6px;border-radius:4px;font-size:11px;" title="${escapeHtml(r.err || '')}">❌ 失败</span>`;

            rowsHtml += `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:10px 8px;font-size:13px;color:var(--text-secondary,#bbb);">${idx + 1}</td>
                    <td style="padding:10px 8px;font-size:13px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;" title="${escapeHtml(r.fileName)}">${escapeHtml(r.fileName)}</td>
                    <td style="padding:10px 8px;font-size:13px;">${statusBadge}</td>
                    <td style="padding:10px 8px;font-size:12px;color:var(--text-secondary,#bbb);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(r.text || '')}">${escapeHtml(r.text || '')}</td>
                </tr>
            `;
        });

        content.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:24px;">📊</span>
                <h3 style="margin:0;color:var(--text-primary,#eee);font-size:18px;">批量对齐字幕报告</h3>
            </div>
            <div style="display:flex;gap:16px;background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.05);justify-content:space-around;text-align:center;">
                <div>
                    <div style="font-size:12px;color:var(--text-secondary,#bbb);">总任务数</div>
                    <div style="font-size:20px;font-weight:bold;color:var(--text-primary,#eee);">${total}</div>
                </div>
                <div style="border-left:1px solid rgba(255,255,255,0.1);height:30px;align-self:center;"></div>
                <div>
                    <div style="font-size:12px;color:var(--text-secondary,#bbb);color:#4ade80;">对齐成功</div>
                    <div style="font-size:20px;font-weight:bold;color:#4ade80;">${okCount}</div>
                </div>
                <div style="border-left:1px solid rgba(255,255,255,0.1);height:30px;align-self:center;"></div>
                <div>
                    <div style="font-size:12px;color:var(--text-secondary,#bbb);color:#ef4444;">失败/跳过</div>
                    <div style="font-size:20px;font-weight:bold;color:#ef4444;">${failCount}</div>
                </div>
            </div>
            <div style="max-height:250px;overflow-y:auto;border:1px solid rgba(255,255,255,0.08);border-radius:8px;">
                <table style="width:100%;border-collapse:collapse;text-align:left;">
                    <thead>
                        <tr style="background:rgba(255,255,255,0.02);border-bottom:1px solid rgba(255,255,255,0.08);">
                            <th style="padding:8px;font-size:12px;font-weight:bold;color:var(--text-secondary,#bbb);width:30px;">#</th>
                            <th style="padding:8px;font-size:12px;font-weight:bold;color:var(--text-secondary,#bbb);width:180px;">任务名称</th>
                            <th style="padding:8px;font-size:12px;font-weight:bold;color:var(--text-secondary,#bbb);width:100px;">对齐状态</th>
                            <th style="padding:8px;font-size:12px;font-weight:bold;color:var(--text-secondary,#bbb);">对齐文案内容</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:8px;">
                <button id="reels-summary-close-btn" class="btn btn-primary" style="background:var(--accent,#7b8bef);color:white;border:none;font-size:13px;padding:8px 24px;cursor:pointer;border-radius:6px;">我知道了</button>
            </div>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        const cleanup = () => {
            document.body.removeChild(modal);
            resolve();
        };

        modal.querySelector('#reels-summary-close-btn').addEventListener('click', cleanup);
    });
}

async function _reelsAlignSubtitles(task, ignoreMismatch = false) {
    const txtContent = task.txtContent || task.manualText || '';
    if (!txtContent.trim()) throw new Error('没有字幕文本');

    // 确定音频源路径
    const workMode = _getWorkMode();
    let audioPath;
    if (workMode === 'voiced_bg') {
        audioPath = task.bgPath || task.videoPath;
    } else {
        audioPath = task.audioPath;
    }
    if (!audioPath) throw new Error('没有音频文件可用于对齐');

    // 调用现有的 subtitle/generate API
    const language = document.getElementById('reels-align-lang')?.value || '英语';
    const alignModel = document.getElementById('reels-align-model')?.value || localStorage.getItem('rbt_align_model') || 'music_mv';
    // 输出目录 = 音频/视频文件所在目录（SRT 保存到文件旁边）
    const audioDir = audioPath.replace(/[\\/][^\\/]+$/, '');
    const response = await apiFetch(`${API_BASE}/subtitle/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            audio_path: audioPath,
            source_text: txtContent,
            language: language,
            audio_cut_length: 5.0,
            output_dir: audioDir,
            preferred_provider: alignModel,
            music_mode: alignModel === 'music_mv',
            ignore_mismatch: ignoreMismatch
        }),
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || '字幕对齐失败');
    }

    const data = await response.json();

    // 生成的 SRT 文件路径
    if (data.files && data.files.length > 0) {
        // 找到 source.srt 文件
        const srtFile = data.files.find(f => f.endsWith('_source.srt')) || data.files[0];
        task.srtPath = srtFile;

        // 读取 SRT 文件并解析为 segments
        if (window.electronAPI && window.electronAPI.readFileText) {
            const srtContent = await window.electronAPI.readFileText(srtFile);
            const rawSegs = parseSRT(srtContent).map(seg => ({ ...seg, _timeUnit: 'sec' }));
            task.segments = window.ReelsSubtitleProcessor
                ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
                : rawSegs;
        }
    }

    task.aligned = true;
    return task;
}

// 对齐所有未对齐的 TXT 任务
async function reelsAlignAllTasks() {
    const workMode = _getWorkMode();
    if (workMode === 'srt') return; // SRT 模式不需要对齐

    const tasksToAlign = _reelsState.tasks.filter(t =>
        t.txtContent && !t.aligned && (t.segments || []).length === 0
    );
    if (tasksToAlign.length === 0) {
        alert('没有需要对齐的任务');
        return;
    }

    const statusEl = document.getElementById('reels-export-status');
    let ok = 0, fail = 0;
    const alignResults = [];

    for (let i = 0; i < tasksToAlign.length; i++) {
        const task = tasksToAlign[i];
        if (statusEl) statusEl.textContent = `对齐中 ${i + 1}/${tasksToAlign.length}: ${task.fileName}`;

        let retryAlign = true;
        let ignoreMismatch = false;
        let finalStatus = 'FAILED';
        let errMsg = '';

        while (retryAlign) {
            retryAlign = false;
            try {
                await _reelsAlignSubtitles(task, ignoreMismatch);
                ok++;
                finalStatus = ignoreMismatch ? 'FORCE' : 'SUCCESS';
            } catch (err) {
                const message = err.message;
                if (message.includes('"code":"TEXT_MISMATCH"')) {
                    try {
                        const mismatchData = JSON.parse(message);
                        const choice = await reelsShowMismatchDialog(task.fileName, mismatchData, task.txtContent || task.manualText || '');
                        if (choice === 'USE_RECOGNIZED') {
                            task.txtContent = mismatchData.recognized_text;
                            retryAlign = true;
                            finalStatus = 'CORRECTED';
                            continue;
                        } else if (choice === 'FORCE') {
                            ignoreMismatch = true;
                            retryAlign = true;
                            continue;
                        } else {
                            // SKIP
                            fail++;
                            finalStatus = 'SKIPPED';
                        }
                    } catch (e) {
                        console.error('[Reels] Failed to parse mismatch err:', e);
                        fail++;
                        finalStatus = 'FAILED';
                        errMsg = message;
                    }
                } else {
                    console.error('[Reels] Align failed:', task.fileName, err);
                    fail++;
                    finalStatus = 'FAILED';
                    errMsg = message;
                }
            }
        }

        alignResults.push({
            fileName: task.fileName,
            status: finalStatus,
            text: task.txtContent || task.manualText || '',
            err: errMsg
        });
    }

    _renderTaskList();
    if (statusEl) {
        statusEl.textContent = fail > 0
            ? `⚠️ 对齐完成 ${ok}/${tasksToAlign.length}，失败 ${fail}`
            : `✅ 对齐完成 (${ok}个任务)`;
    }
    
    // Show summary modal
    await reelsShowAlignSummaryModal(alignResults);
}

// ═══════════════════════════════════════════════════════
// Work mode switching
// ═══════════════════════════════════════════════════════

function reelsOnWorkModeChange() {
    const mode = _getWorkMode();
    // 隐藏对应的菜单项 wrap，或直接元素
    const audioBtn = document.getElementById('reels-audio-input')?.nextElementSibling;
    const srtBtn = document.getElementById('reels-srt-input')?.nextElementSibling;
    const txtWrap = document.getElementById('reels-txt-btn-wrap');
    const manualWrap = document.getElementById('reels-manual-btn-wrap');
    const alignWrap = document.getElementById('reels-align-btn-wrap');
    const alignLang = document.getElementById('reels-align-lang');
    
    // 背景的文字
    const bgInput = document.getElementById('reels-video-input');
    const bgLabel = bgInput ? bgInput.nextElementSibling : null;

    if (mode === 'srt') {
        // 人声Reels: 背景 + 配音 + SRT
        if (audioBtn) audioBtn.style.display = '';
        if (srtBtn) srtBtn.style.display = '';
        if (txtWrap) txtWrap.style.display = 'none';
        if (manualWrap) manualWrap.style.display = 'none';
        if (alignWrap) alignWrap.style.display = 'none';
        if (alignLang) alignLang.style.display = 'none';
        if (bgLabel) bgLabel.innerHTML = '📁 导入背景素材';
    } else if (mode === 'dubbed_text') {
        // 配音+文本: 背景 + 配音 + TXT
        if (audioBtn) audioBtn.style.display = '';
        if (srtBtn) srtBtn.style.display = 'none';
        if (txtWrap) txtWrap.style.display = '';
        if (manualWrap) manualWrap.style.display = '';
        if (alignWrap) alignWrap.style.display = '';
        if (alignLang) alignLang.style.display = '';
        if (bgLabel) bgLabel.innerHTML = '📁 导入背景素材';
    } else if (mode === 'voiced_bg') {
        // 带声视频: 带声视频 + TXT
        if (audioBtn) audioBtn.style.display = 'none';
        if (srtBtn) srtBtn.style.display = 'none';
        if (txtWrap) txtWrap.style.display = '';
        if (manualWrap) manualWrap.style.display = '';
        if (alignWrap) alignWrap.style.display = '';
        if (alignLang) alignLang.style.display = '';
        if (bgLabel) bgLabel.innerHTML = '📁 导入带声视频';
    }
}

function _queueMixedFiles(files, options = {}) {
    const workMode = _getWorkMode();
    const sortedFiles = Array.from(files || []).sort(_naturalCompareFileNames);
    for (const file of sortedFiles) {
        const ext = _fileExt(file.name || '');
        if (ext === 'srt' && workMode === 'srt') {
            _queueSrtFile(file);
        } else if (ext === 'txt' && workMode !== 'srt') {
            _queueTxtFile(file);
        } else if (ext === 'srt') {
            _queueSrtFile(file);
        } else if (REELS_AUDIO_EXTS.has(ext)) {
            _queueAudioFile(file);
        } else if (REELS_BACKGROUND_EXTS.has(ext)) {
            _queueBackgroundFile(file, { createTask: options.createBackgroundTasks === true });
        }
    }
}

function _onVideoFilesSelected(e) {
    const files = Array.from(e.target.files || []).sort(_naturalCompareFileNames);
    for (const f of files) _queueBackgroundFile(f);
    reelsAutoMatchFiles();
    e.target.value = '';
}

function _onAudioFilesSelected(e) {
    const files = Array.from(e.target.files || []).sort(_naturalCompareFileNames);
    for (const f of files) _queueAudioFile(f);
    reelsAutoMatchFiles();
    e.target.value = '';
}

function _onSrtFilesSelected(e) {
    const files = Array.from(e.target.files || []).sort(_naturalCompareFileNames);
    for (const f of files) _queueSrtFile(f);
    e.target.value = '';
}

function _onFolderFilesSelected(e) {
    const files = Array.from(e.target.files || []).sort(_naturalCompareFileNames);
    _queueMixedFiles(files);
    reelsAutoMatchFiles();
    e.target.value = '';
}

function _scanDroppedReelsTaskFolder(dirPath, maxDepth = 20) {
    const api = window.electronAPI;
    if (!api?.fsReaddir || !api?.pathJoin) return [];
    const files = [];

    const walk = (currentDir, depth) => {
        if (depth > maxDepth) return;
        for (const entry of api.fsReaddir(currentDir) || []) {
            if (!entry?.name || entry.name.startsWith('.') || entry.name === 'Thumbs.db' || entry.name === 'desktop.ini') continue;
            const fullPath = api.pathJoin(currentDir, entry.name);
            if (entry.isDirectory) walk(fullPath, depth + 1);
            else if (entry.isFile) files.push(fullPath);
        }
    };
    walk(dirPath, 0);
    return files.sort(_naturalCompareFileNames);
}

function _reelsPathParent(filePath) {
    const value = String(filePath || '').replace(/\\/g, '/');
    const slash = value.lastIndexOf('/');
    return slash >= 0 ? value.slice(0, slash).toLowerCase() : '';
}

// 外层拖入会递归收集整个任务文件夹。不能只按文件名配对：常见结构是
// `背景/xxx.mp4`、`配音/xxx.mp3`、`字幕/xxx.srt`，或者一个子目录里只有
// 一份配音/字幕但背景有多段。优先同名，其次同目录唯一，最后整个任务夹唯一。
function _pickDroppedFolderCompanion(filePath, byKey, byParent, allFiles) {
    const parent = _reelsPathParent(filePath);
    const name = String(filePath || '').split(/[\\/]/).pop() || filePath;
    const key = `${parent}\u0000${_buildAudioSubtitleMatchKey(name)}`;
    const exact = byKey.get(key) || [];
    if (exact.length) return exact[0];
    const siblings = byParent.get(parent) || [];
    if (siblings.length === 1) return siblings[0];
    return allFiles.length === 1 ? allFiles[0] : null;
}

function _importDroppedReelsTaskFolders(dirPaths) {
    const api = window.electronAPI;
    if (!api?.readFileText) return { imported: 0, skipped: (dirPaths || []).length };
    let imported = 0;
    let importedFolders = 0;
    let skipped = 0;
    let unmatched = 0;
    let replaced = 0;
    let firstImportedIndex = -1;
    const detected = { videos: 0, audios: 0, srts: 0, txts: 0 };
    const workMode = _getWorkMode();

    for (const dirPath of dirPaths || []) {
        const paths = _scanDroppedReelsTaskFolder(dirPath);
        const videos = paths.filter(p => REELS_BACKGROUND_EXTS.has(_fileExt(p)));
        const audios = paths.filter(p => REELS_AUDIO_EXTS.has(_fileExt(p)));
        const srts = paths.filter(p => _fileExt(p) === 'srt');
        const txts = paths.filter(p => _fileExt(p) === 'txt');
        detected.videos += videos.length;
        detected.audios += audios.length;
        detected.srts += srts.length;
        detected.txts += txts.length;
        // 人声模式允许只拖入 MP3：背景视频、SRT 和 TXT 都可在批量表格中后补。
        // 带声视频模式则必须至少有一个视频作为音频识别源。
        const requiresVideo = workMode === 'voiced_bg';
        if ((requiresVideo && videos.length === 0) || (!requiresVideo && audios.length === 0)) {
            skipped++;
            continue;
        }

        const folderName = api.pathBasename?.(dirPath) || String(dirPath).split(/[\\/]/).pop() || `任务${_reelsState.tasks.length + 1}`;
        const queueId = `folder:${dirPath}`;
        const byMatchKey = list => {
            const map = new Map();
            for (const filePath of list) {
                const key = `${_reelsPathParent(filePath)}\u0000${_buildAudioSubtitleMatchKey(api.pathBasename?.(filePath) || filePath)}`;
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(filePath);
            }
            return map;
        };
        const byParent = list => list.reduce((map, filePath) => {
            const parent = _reelsPathParent(filePath);
            if (!map.has(parent)) map.set(parent, []);
            map.get(parent).push(filePath);
            return map;
        }, new Map());
        const srtMap = byMatchKey(srts);
        const txtMap = byMatchKey(txts);
        const srtsByParent = byParent(srts);
        const txtsByParent = byParent(txts);
        const pairs = [];
        const usedSrts = new Set();
        const usedTxts = new Set();
        if (workMode === 'voiced_bg') {
            // 带声视频模式不需要独立配音；一个视频对应同名/同目录唯一的字幕或 TXT。
            for (let i = 0; i < videos.length; i++) {
                const videoPath = videos[i];
                const matchKey = _buildAudioSubtitleMatchKey(api.pathBasename?.(videoPath) || videoPath);
                const srtPath = _pickDroppedFolderCompanion(videoPath, srtMap, srtsByParent, srts);
                const txtPath = _pickDroppedFolderCompanion(videoPath, txtMap, txtsByParent, txts);
                if (srtPath) usedSrts.add(srtPath);
                if (txtPath) usedTxts.add(txtPath);
                pairs.push({
                    matchKey,
                    videoPath,
                    audioPath: null,
                    srtPath,
                    txtPath,
                });
            }
        } else {
            // 每个 MP3 都建立一行；SRT/TXT 优先同名，再落到同目录唯一或全夹唯一。
            // 这使“背景、MP3、SRT 分三个子文件夹”的真实目录也能完整导入。
            for (const audioPath of audios) {
                const audioName = api.pathBasename?.(audioPath) || audioPath;
                const matchKey = _buildAudioSubtitleMatchKey(audioName);
                const srtPath = _pickDroppedFolderCompanion(audioPath, srtMap, srtsByParent, srts);
                const txtPath = _pickDroppedFolderCompanion(audioPath, txtMap, txtsByParent, txts);
                if (srtPath) usedSrts.add(srtPath);
                if (txtPath) usedTxts.add(txtPath);
                pairs.push({ matchKey, audioPath, srtPath, txtPath });
            }
            // 缺字幕不会阻断 MP3 导入；仅把真正没有挂到任何任务的字幕/TXT 计入反馈。
            unmatched += srts.filter(path => !usedSrts.has(path)).length;
            unmatched += txts.filter(path => !usedTxts.has(path)).length;
        }
        if (pairs.length === 0) {
            skipped++;
            continue;
        }

        // 重新拖入同一文件夹时，清除旧版错误导入产生的背景-only/合并任务，
        // 再按当前 MP3+SRT 配套规则完整重建该文件夹队列。
        const normalizedDir = String(dirPath).replace(/[\\/]+$/, '');
        const isTaskFromDir = task => {
            if (task._sourceFolder === dirPath || task._folderQueueId === queueId) return true;
            const pathsToCheck = [
                task.audioPath, task.srtPath, task.txtPath, task.bgPath, task.videoPath,
                ...(Array.isArray(task.bgClipPool) ? task.bgClipPool : []),
            ].filter(Boolean);
            return pathsToCheck.some(filePath => {
                const value = String(filePath);
                return value === normalizedDir || value.startsWith(normalizedDir + '/') || value.startsWith(normalizedDir + '\\');
            });
        };
        const oldLength = _reelsState.tasks.length;
        _reelsState.tasks = _reelsState.tasks.filter(task => !isTaskFromDir(task));
        replaced += oldLength - _reelsState.tasks.length;

        importedFolders++;

        const assignMode = _getBgAssignMode();
        for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
            const { matchKey, audioPath, srtPath, txtPath } = pairs[pairIndex];
            const videoPath = pairs[pairIndex].videoPath || (videos.length > 0
                ? (assignMode === 'single' ? videos[0] : videos[pairIndex % videos.length])
                : null);
            const sourceName = audioPath || videoPath;
            const audioName = api.pathBasename?.(sourceName) || String(sourceName).split(/[\\/]/).pop();
            const srcUrl = api.toFileUrl?.(videoPath) || null;
            const task = {
                id: 'task_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now() + '_' + imported,
                baseName: _normalizeBaseName(audioName),
                fileName: audioName.replace(/\.[^.]+$/, '.mp4'),
                exportName: _normalizeBaseName(audioName),
                matchKey,
                _sourceFolder: dirPath,
                _folderQueueId: queueId,
                _folderQueueName: folderName,
                bgPath: videoPath,
                bgSrcUrl: srcUrl,
                videoPath,
                srcUrl,
                bgMode: 'single',
                bgClipPool: [],
                bgClipActivePool: [],
                audioPath,
                srtPath,
                txtPath,
                txtContent: txtPath ? (api.readFileText(txtPath) || '') : '',
                segments: [],
                aligned: false,
            };

            if (srtPath) {
                const srtContent = api.readFileText(srtPath) || '';
                const rawSegs = parseSRT(srtContent).map(seg => ({ ...seg, _timeUnit: 'sec' }));
                task.segments = window.ReelsSubtitleProcessor
                    ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
                    : rawSegs;
                task.aligned = task.segments.length > 0;
            }

            if (firstImportedIndex < 0) firstImportedIndex = _reelsState.tasks.length;
            _reelsState.tasks.push(task);
            imported++;
        }
    }

    if (imported > 0) {
        // 外部拖入的每个账号/文件夹队列，同时自动建立同名批量表格标签页。
        // 任务列表保持合并显示；进入批量表格后可分别编辑每个账号。
        if (typeof window.reelsSyncExternalFolderQueuesToTabs === 'function') {
            window.reelsSyncExternalFolderQueuesToTabs();
        }
        _renderTaskList();
        reelsSelectTask(firstImportedIndex);
        if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
    }
    return { imported, importedFolders, skipped, unmatched, replaced, detected };
}

function reelsToggleFolderQueue(queueId) {
    if (!queueId) return;
    const queueTask = (_reelsState.tasks || []).find(task => task._folderQueueId === queueId);
    const parentGroupId = queueTask
        ? (queueTask._batchTabId || '__reels_existing_tasks__')
        : '';

    // 外层批量组折叠时，单击某个文件夹应直接展开它，
    // 不能只翻转内层箭头却仍被外层 display:none 压住。
    if (parentGroupId && _reelsState.batchGroupCollapsed?.[parentGroupId]) {
        _reelsState.batchGroupCollapsed[parentGroupId] = false;
        // 外层打开后，其他内层队列原本也是“展开”状态，会造成
        // 点一个却全部展开。先收起同组其他队列，只保留本次点击的队列。
        const siblingQueueIds = new Set(
            (_reelsState.tasks || [])
                .filter(task => (task._batchTabId || '__reels_existing_tasks__') === parentGroupId)
                .map(task => task._folderQueueId)
                .filter(Boolean)
        );
        siblingQueueIds.forEach(id => {
            _reelsState.folderQueueCollapsed[id] = id !== queueId;
        });
        _reelsState.folderQueueCollapsed[queueId] = false;
        _renderTaskList({ preserveScroll: true });
        return;
    }
    _reelsState.folderQueueCollapsed[queueId] = !_reelsState.folderQueueCollapsed[queueId];
    _renderTaskList({ preserveScroll: true });
}

function reelsToggleFolderQueueExport(queueId, checked) {
    (_reelsState.tasks || []).forEach(task => {
        if (task._folderQueueId === queueId) task._exportSelected = !!checked;
    });
    _renderTaskList({ preserveScroll: true });
}
window.reelsToggleFolderQueueExport = reelsToggleFolderQueueExport;

function _reelsTaskSortLabel(task, mode) {
    if (mode === 'export-name') return String(task.exportName || task.fileName || task.baseName || '');
    if (mode === 'file-name') {
        return String(task.bgPath || task.videoPath || task.audioPath || task.srtPath || task.fileName || task.baseName || '').split(/[\\/]/).pop();
    }
    return '';
}

function reelsSortTasks(mode = 'manual') {
    const sortMode = String(mode || 'manual');
    if (sortMode === 'manual') return;
    const selectedTask = _getSelectedTask();
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    // 不跨分组重排：分组标题、文件夹队列和它们的批量配置都要保持原样。
    const groups = new Map();
    _reelsState.tasks.forEach((task, index) => {
        const key = `${task._batchTabId || '__existing__'}\u0000${task._folderQueueId || '__none__'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ task, index });
    });
    for (const entries of groups.values()) {
        const sorted = entries.slice().sort((a, b) => {
            if (sortMode === 'import-asc' || sortMode === 'import-desc') {
                const aTime = Number(a.task.importedAt) || 0;
                const bTime = Number(b.task.importedAt) || 0;
                const difference = aTime - bTime;
                if (difference) return sortMode === 'import-desc' ? -difference : difference;
            } else {
                const difference = collator.compare(_reelsTaskSortLabel(a.task, sortMode), _reelsTaskSortLabel(b.task, sortMode));
                if (difference) return difference;
            }
            return a.index - b.index;
        });
        entries.forEach((entry, position) => { _reelsState.tasks[entry.index] = sorted[position].task; });
    }
    _reelsState.selectedIdx = selectedTask ? _reelsState.tasks.indexOf(selectedTask) : -1;
    _renderTaskList();
    if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
}
window.reelsSortTasks = reelsSortTasks;

function reelsTaskDragStart(event, index) {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-videokit-reels-task-index', String(index));
    event.currentTarget.style.opacity = '0.45';
}
window.reelsTaskDragStart = reelsTaskDragStart;

function reelsTaskDragEnd(event) {
    if (event.currentTarget) event.currentTarget.style.opacity = '';
}
window.reelsTaskDragEnd = reelsTaskDragEnd;

function _onTaskListDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.style.borderColor = '';
    e.currentTarget.style.backgroundColor = '';
    e.currentTarget.style.boxShadow = '';
    const draggedRaw = e.dataTransfer?.getData('application/x-videokit-reels-task-index');
    const draggedIndex = draggedRaw !== '' && draggedRaw != null ? Number(draggedRaw) : NaN;
    if (Number.isInteger(draggedIndex) && draggedIndex >= 0 && draggedIndex < _reelsState.tasks.length) {
        const targetRow = e.target.closest?.('.reels-task-item');
        const targetIndex = Number(targetRow?.dataset?.taskIdx);
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= _reelsState.tasks.length || targetIndex === draggedIndex) return;
        const sourceTask = _reelsState.tasks[draggedIndex];
        const targetTask = _reelsState.tasks[targetIndex];
        // 分组和文件夹队列各自有标题及批量规则；跨组挪动会破坏这些关系，
        // 因此允许组内排序，跨组请先用批量表格移动任务。
        if ((sourceTask._batchTabId || '') !== (targetTask._batchTabId || '') || (sourceTask._folderQueueId || '') !== (targetTask._folderQueueId || '')) {
            if (typeof showToast === 'function') showToast('任务只能在同一分组内拖动排序', 'warning');
            return;
        }
        const selectedTask = _getSelectedTask();
        _reelsState.tasks.splice(draggedIndex, 1);
        const insertionIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
        _reelsState.tasks.splice(insertionIndex, 0, sourceTask);
        _reelsState.selectedIdx = selectedTask ? _reelsState.tasks.indexOf(selectedTask) : -1;
        const sortSelect = document.getElementById('reels-task-sort');
        if (sortSelect) sortSelect.value = 'manual';
        _renderTaskList();
        if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
        return;
    }
    const files = Array.from(e.dataTransfer.files || []);
    // 必须消费 preload 在捕获阶段保存的路径。否则单独拖入背景时，File 经
    // contextIsolation 转换后可能取不到绝对路径，结果看起来像“拖不进去”。
    const droppedPaths = window.electronAPI?.consumeDroppedFilePaths?.() || [];
    files.forEach((file, index) => {
        if (droppedPaths[index]) file._nativePath = droppedPaths[index];
    });
    // 某些 macOS/Electron 组合会把 DataTransfer 的 File 列表传给页面，
    // 却让其中的文件拿不到路径；也有场景只留下 preload 捕获的原始路径。
    // 补成最小文件描述后，单独拖背景仍能进入导入链路。
    const knownPaths = new Set(files.map(file => file._nativePath).filter(Boolean));
    for (const nativePath of droppedPaths) {
        if (!nativePath || knownPaths.has(nativePath)) continue;
        files.push({
            name: String(nativePath).split(/[\\/]/).pop() || nativePath,
            _nativePath: nativePath,
            path: nativePath,
        });
    }
    const fileEntries = files.map(file => ({
        file,
        path: file._nativePath || ((typeof getFileNativePath === 'function') ? getFileNativePath(file) : (file.path || '')),
    })).filter(item => item.path);
    const dirs = fileEntries.filter(item => window.electronAPI?.isDirectory?.(item.path)).map(item => item.path);
    const regularEntries = fileEntries.filter(item => !window.electronAPI?.isDirectory?.(item.path));
    const regularFiles = regularEntries.map(item => item.file);

    if (dirs.length > 0) {
        const result = _importDroppedReelsTaskFolders(dirs);
        if (typeof showToast === 'function') {
            if (result.imported > 0) {
                showToast(
                    `📁 已建立 ${result.importedFolders} 个文件夹队列，共 ${result.imported} 个独立任务`
                    + `；识别到 ${result.detected?.videos || 0} 个背景视频、${result.detected?.audios || 0} 个音频、${result.detected?.srts || 0} 个 SRT`
                    + `${result.replaced ? `；已替换 ${result.replaced} 个旧任务` : ''}`
                    + `${result.unmatched ? `；${result.unmatched} 个字幕/TXT未能唯一配对，未挂入任务` : ''}`
                    + `${result.skipped ? `；跳过 ${result.skipped} 个无完整配套内容的文件夹` : ''}`,
                    'success',
                    7000
                );
            } else {
                const requirement = _getWorkMode() === 'voiced_bg'
                    ? '至少一个带声视频文件'
                    : '至少一个配音文件（MP3 等）';
                showToast(`未导入任务：文件夹需包含${requirement}`, 'warning', 6000);
            }
        }
    }
    if (regularEntries.length > 0) {
        // 如果直接拖入单个或多个视频/图片到指定任务行，直接绑定到该任务行
        const targetRow = e.target.closest?.('.reels-task-item');
        const targetIndex = targetRow ? Number(targetRow.dataset?.taskIdx) : -1;
        const allVisualBg = regularEntries.every(item => REELS_BACKGROUND_EXTS.has(_fileExt(item.file.name || item.path || '')));
        if (Number.isInteger(targetIndex) && targetIndex >= 0 && targetIndex < _reelsState.tasks.length && allVisualBg) {
            const sortedBgPaths = regularEntries
                .slice()
                .sort((a, b) => _naturalCompareFileNames(a.file, b.file))
                .map(item => item.path)
                .filter(Boolean);
            const targetTask = _reelsState.tasks[targetIndex];
            if (targetTask && sortedBgPaths.length > 0) {
                const firstPath = sortedBgPaths[0];
                const firstUrl = window.electronAPI?.toFileUrl?.(firstPath) || null;
                if (sortedBgPaths.length === 1) {
                    targetTask.bgMode = 'single';
                    targetTask.bgClipPool = [];
                    targetTask.bgClipActivePool = [];
                } else {
                    targetTask.bgMode = 'multi';
                    targetTask.bgClipPool = sortedBgPaths;
                    targetTask.bgClipActivePool = [];
                    targetTask.bgClipOrder = targetTask.bgClipOrder || 'sequence';
                    targetTask.bgTransition = targetTask.bgTransition || 'crossfade';
                    targetTask.bgTransDur = targetTask.bgTransDur ?? 0.5;
                }
                targetTask.bgPath = firstPath;
                targetTask.videoPath = firstPath;
                targetTask.bgSrcUrl = firstUrl;
                targetTask.srcUrl = firstUrl;
                _renderTaskList({ preserveScroll: true });
                reelsSelectTask(targetIndex);
                if (typeof _batchAutoSave === 'function') _batchAutoSave();
                if (typeof showToast === 'function') {
                    showToast(
                        sortedBgPaths.length > 1
                            ? `🎬 已将 ${sortedBgPaths.length} 个素材设为第 ${targetIndex + 1} 行的多素材背景`
                            : `✅ 已更新第 ${targetIndex + 1} 行的背景素材`,
                        'success'
                    );
                }
                return;
            }
        }

        _queueMixedFiles(regularFiles, { createBackgroundTasks: true });
        reelsAutoMatchFiles();
        const backgroundCount = regularFiles.filter(file => REELS_BACKGROUND_EXTS.has(_fileExt(file.name || ''))).length;
        if (backgroundCount > 0 && typeof showToast === 'function') {
            showToast(`已导入 ${backgroundCount} 个背景素材；可继续拖入配音和 SRT 自动配对`, 'success', 4500);
        }
    }
}

function _getMatchMode() {
    const el = document.getElementById('reels-match-mode');
    return el ? el.value : 'free';
}

function _getWorkMode() {
    const el = document.getElementById('reels-work-mode');
    return el ? el.value : 'srt';
}

function _getBgAssignMode() {
    const el = document.getElementById('reels-bg-assign-mode');
    return el ? el.value : 'cycle';
}

function _applyFreeBackgroundAssignment({ backgrounds = [], targetTasks = [] } = {}) {
    // 背景自动分配必须是“一次导入”的局部动作：历史背景库仅用于展示和
    // 手动选择，不能在随后又导入一条音频/SRT 时把旧任务重新洗牌。
    const library = backgrounds.filter(item => item?.path);
    if (library.length === 0) return;

    const assignMode = _getBgAssignMode();
    // 只处理本次导入刚创建/刚补全、且尚未绑定背景的任务。已有背景不论是
    // 自动还是手工设置，均视为用户已确认，绝不被后续导入覆盖。
    const uniqueTargets = [...new Set(targetTasks)].filter(t =>
        t && (t.audioPath || t.srtPath || t.txtContent || t.manualText)
        && !(t._keepBackgroundOnly === true && (t.bgPath || t.videoPath))
        && !(t.bgPath || t.videoPath)
    );
    const targets = uniqueTargets;
    if (targets.length === 0) return;

    if (assignMode === 'single') {
        const firstBg = library[0];
        for (const task of targets) {
            task.bgPath = firstBg.path;
            task.bgSrcUrl = firstBg.srcUrl || null;
            task.videoPath = firstBg.path;
            task.srcUrl = firstBg.srcUrl || null;
        }
        return;
    }

    for (let i = 0; i < targets.length; i++) {
        const bg = library[i % library.length];
        targets[i].bgPath = bg.path;
        targets[i].bgSrcUrl = bg.srcUrl || null;
        targets[i].videoPath = bg.path;
        targets[i].srcUrl = bg.srcUrl || null;
    }
}

function _ensurePreviewTaskForBackgroundOnlyInFreeMode() {
    if (_getMatchMode() !== 'free') return;
    if (_reelsState.tasks.length > 0) return;
    const firstBg = (_reelsState.backgroundLibrary || [])[0];
    if (!firstBg || !firstBg.path) return;

    const task = _getOrCreateTaskByBase(firstBg.baseName || firstBg.name, firstBg.name || 'background.mp4');
    task.baseName = firstBg.baseName || _normalizeBaseName(firstBg.name || firstBg.path);
    task.fileName = firstBg.name || String(firstBg.path).split(/[\\/]/).pop() || 'background.mp4';
    task.bgPath = firstBg.path;
    task.bgSrcUrl = firstBg.srcUrl || null;
    task.videoPath = firstBg.path;
    task.srcUrl = firstBg.srcUrl || null;
}

function _ensureBackgroundLibraryFromTasks() {
    for (const task of _reelsState.tasks) {
        const bgPath = task.bgPath || task.videoPath;
        if (!bgPath) continue;
        _upsertBackgroundLibrary({
            path: bgPath,
            name: String(bgPath).split(/[\\/]/).pop(),
            baseName: _normalizeBaseName(bgPath),
            srcUrl: task.bgSrcUrl || task.srcUrl || null,
        });
    }
}

function _getOrCreateFreeTaskForAudio(audio) {
    const base = _normalizeBaseName(audio.baseName || audio.name);
    const key = audio.matchKey || _buildAudioSubtitleMatchKey(base);
    let task = _reelsState.tasks.find(t => !t.audioPath && t.matchKey === key);
    if (!task) task = _getOrCreateTaskByBase(base, audio.name);
    task.matchKey = key;
    return task;
}

function _getOrCreateFreeTaskForSrt(srt) {
    const base = _normalizeBaseName(srt.baseName || srt.name);
    const key = srt.matchKey || _buildAudioSubtitleMatchKey(base);
    let task = _reelsState.tasks.find(t => !t.srtPath && t.matchKey === key);
    if (!task) task = _getOrCreateTaskByBase(base, srt.name);
    task.matchKey = key;
    return task;
}

function _pruneFreeBgOnlyTasks() {
    _reelsState.tasks = _reelsState.tasks.filter(t => {
        const hasBg = !!(t.bgPath || t.videoPath);
        const hasAudio = !!t.audioPath;
        const hasSrt = !!t.srtPath;
        const hasTxt = !!t.txtContent;
        // 任务区直接拖入的背景是明确创建的任务，不能因暂未附加音频/字幕而
        // 被自由匹配的清理逻辑移除。
        if (hasBg && !hasAudio && !hasSrt && !hasTxt) return t._keepBackgroundOnly === true;
        return true;
    });
}

function reelsAutoMatchFiles() {
    const backgrounds = _reelsState.pendingFiles.backgrounds.splice(0).sort(_naturalCompareFileNames);
    const audios = _reelsState.pendingFiles.audios.splice(0).sort(_naturalCompareFileNames);
    const srts = _reelsState.pendingFiles.srts.splice(0).sort(_naturalCompareFileNames);
    const txts = _reelsState.pendingFiles.txts.splice(0).sort(_naturalCompareFileNames);
    const receivedFiles = backgrounds.length + audios.length + srts.length + txts.length > 0;
    const matchMode = _getMatchMode();
    // 用对象引用而非索引记录本次导入涉及的任务；导入流程可能会新建任务或
    // 清理仅背景占位任务，索引在这期间并不稳定。
    const importedTasks = new Set();

    for (const bg of backgrounds) {
        _upsertBackgroundLibrary(bg);
        if (matchMode === 'free' && bg.createTask) {
            const task = _getOrCreateTaskByBase(bg.baseName, bg.name);
            importedTasks.add(task);
            task.baseName = bg.baseName;
            task.matchKey = bg.matchKey || _buildAudioSubtitleMatchKey(bg.name);
            task.bgPath = bg.path;
            task.bgSrcUrl = bg.srcUrl || null;
            task.videoPath = bg.path;
            task.srcUrl = bg.srcUrl || null;
            task._keepBackgroundOnly = true;
            if (!task.fileName) task.fileName = bg.name;
            continue;
        }
        if (matchMode !== 'strict') continue;
        const task = _getOrCreateTaskByBase(bg.baseName, bg.name);
        importedTasks.add(task);
        task.baseName = bg.baseName;
        task.bgPath = bg.path;
        task.bgSrcUrl = bg.srcUrl || null;
        // 兼容旧导出逻辑字段
        task.videoPath = bg.path;
        task.srcUrl = bg.srcUrl || null;
        if (!task.fileName) task.fileName = bg.name;
    }

    for (const audio of audios) {
        const task = matchMode === 'free'
            ? _getOrCreateFreeTaskForAudio(audio)
            : _getOrCreateTaskByBase(audio.baseName, audio.name);
        importedTasks.add(task);
        task.baseName = audio.baseName;
        task.audioPath = audio.path;
        if (matchMode === 'free') {
            task.fileName = audio.name;
        } else if (!task.fileName) {
            task.fileName = audio.name;
        }
    }

    for (const srt of srts) {
        const task = matchMode === 'free'
            ? _getOrCreateFreeTaskForSrt(srt)
            : _getOrCreateTaskByBase(srt.baseName, srt.name);
        importedTasks.add(task);
        const rawSegs = parseSRT(srt.content || '').map(seg => ({
            ...seg,
            _timeUnit: 'sec',
        }));
        const segments = window.ReelsSubtitleProcessor
            ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
            : rawSegs;
        task.baseName = srt.baseName;
        task.srtPath = srt.path;
        task.segments = segments;
        if (!task.fileName) task.fileName = srt.name.replace(/\.srt$/i, '.mp4');
    }

    // TXT 文件处理（模式 A/B）
    for (const txt of txts) {
        const task = matchMode === 'free'
            ? _getOrCreateFreeTaskForSrt(txt) // 复用 free 匹配逻辑
            : _getOrCreateTaskByBase(txt.baseName, txt.name);
        importedTasks.add(task);
        task.baseName = txt.baseName;
        task.txtPath = txt.path;
        task.txtContent = txt.content;
        task.aligned = false;
        // 暂不设置 segments，等待对齐后填入
        if (!task.fileName) task.fileName = txt.name.replace(/\.txt$/i, '.mp4');
    }

    if (matchMode === 'free') {
        _pruneFreeBgOnlyTasks();
        _ensureBackgroundLibraryFromTasks();
        _applyFreeBackgroundAssignment({ backgrounds, targetTasks: [...importedTasks] });
        _ensurePreviewTaskForBackgroundOnlyInFreeMode();
    }

    for (const task of _reelsState.tasks) {
        if (!task.baseName) task.baseName = _inferTaskBaseName(task);
        if (!task.fileName) {
            const src = task.audioPath || task.bgPath || task.videoPath || task.srtPath || task.txtPath || '';
            const name = src ? src.split(/[\\/]/).pop() : `${task.baseName || 'reel'}.mp4`;
            task.fileName = name;
        }
    }

    if (_reelsState.selectedIdx >= _reelsState.tasks.length) {
        _reelsState.selectedIdx = _reelsState.tasks.length - 1;
    }
    _renderTaskList();
    if (_reelsState.selectedIdx < 0 && _reelsState.tasks.length > 0) {
        reelsSelectTask(0);
    } else if (receivedFiles && _reelsState.selectedIdx >= 0) {
        // SRT/TXT are read asynchronously. A video/audio path may arrive after
        // the current task was already selected, so explicitly refresh it.
        reelsSelectTask(_reelsState.selectedIdx);
    }
    if (receivedFiles) {
        if (typeof _batchAutoSave === 'function') _batchAutoSave();
        window.ReelsPreviewV2?.recover?.('素材导入完成');
    }
}

function resolveReelsCustomDuration(task, globalDuration) {
    const value = task?.customDuration ?? globalDuration;
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function reelsClearTasks() {
    delete _reelsState._overlayPresetPreviewBackground;
    _setExportSettingValue('reels-custom-duration', '');
    _saveReelsExportSettings();
    _reelsState.tasks = [];
    _reelsState.selectedIdx = -1;
    _reelsState.pendingFiles = { backgrounds: [], audios: [], srts: [], txts: [] };
    _reelsState.backgroundLibrary = [];

    // The batch table owns a second, persisted copy of these tasks. Clearing
    // only the visible queue lets its autosave restore old tabs on the next hot
    // reload/startup. Clear that authoritative snapshot in the same action.
    if (typeof window.reelsClearPersistedBatchTasks === 'function') {
        window.reelsClearPersistedBatchTasks();
    } else {
        // Defensive fallback for an unusually early click before the batch-table
        // script has finished loading.
        try { localStorage.removeItem('reels_batch_config_autosave'); } catch (_) { }
    }

    // Clear overlay manager and panel
    if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        _reelsState.overlayProxy.overlayMgr.overlays = [];
    }
    if (_reelsState.overlayPanel) {
        _reelsState.overlayPanel.deselectOverlay();
        _reelsState.overlayPanel._refreshList();
    }

    // Clear video/audio preview
    _reelsState._previewBgImage = null;
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const placeholder = document.getElementById('reels-preview-placeholder');
    if (video) {
        video.pause();
        video.removeAttribute('src');
        video.style.display = 'none';
    }
    if (audio) {
        audio.pause();
        audio.removeAttribute('src');
    }
    if (placeholder) {
        placeholder.style.display = 'flex';
        placeholder.textContent = '选择视频任务后可实时预览字幕效果';
    }
    _resetPreviewFadeVideo();

    _renderTaskList();
}

function _reelsQueueShortId(value) {
    const input = String(value || 'queue').trim().toLowerCase().replace(/\\/g, '/');
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0').slice(-7);
}

function _getReelsTaskNameDisplay() {
    try {
        return localStorage.getItem(REELS_TASK_NAME_DISPLAY_KEY) === 'full' ? 'full' : 'compact';
    } catch (_) {
        return 'compact';
    }
}

function reelsSetTaskNameDisplay(mode) {
    const nextMode = mode === 'compact' ? 'compact' : 'full';
    try { localStorage.setItem(REELS_TASK_NAME_DISPLAY_KEY, nextMode); } catch (_) { }
    _renderTaskList();
}
window.reelsSetTaskNameDisplay = reelsSetTaskNameDisplay;

function _renderTaskList(options = {}) {
    const container = document.getElementById('reels-task-list');
    const countEl = document.getElementById('reels-task-count');
    const countPanelEl = document.getElementById('reels-task-count-panel');
    if (!container) return;
    const prevScrollTop = container.scrollTop;

    const tasks = _reelsState.tasks;
    const taskNameDisplay = _getReelsTaskNameDisplay();
    container.classList.toggle('reels-task-list-compact', taskNameDisplay === 'compact');
    const nameDisplaySelect = document.getElementById('reels-task-name-display');
    if (nameDisplaySelect && nameDisplaySelect.value !== taskNameDisplay) nameDisplaySelect.value = taskNameDisplay;
    const workMode = _getWorkMode();
    if (countEl) countEl.textContent = `${tasks.length} 个任务`;
    if (countPanelEl) countPanelEl.textContent = tasks.length > 0 ? `${tasks.length}` : '0';

    // 确保所有任务都有 _exportSelected 属性（默认选中）
    tasks.forEach(t => { if (t._exportSelected === undefined) t._exportSelected = true; });
    _updateExportSelectedCountUI();

    if (tasks.length === 0) {
        _updateToggleAllGroupsBtnUI();
        const hint = workMode === 'srt'
            ? '添加背景素材 + 配音 + SRT，支持拖拽和文件夹导入；同名自动配对。'
            : workMode === 'dubbed_text'
                ? '添加背景素材 + 配音 + TXT（或手动输入），然后点击「🔗 对齐」生成字幕时间轴。'
                : '添加带声视频 + TXT（或手动输入），然后点击「🔗 对齐」生成字幕时间轴。';
        container.innerHTML = `<p class="hint" style="font-size:11px;">${hint}</p>`;
        return;
    }

    if (!_reelsState.batchGroupCollapsed) _reelsState.batchGroupCollapsed = {};
    // 没有来源标签页的任务通常是此前已保留在列表中的旧任务。
    // 以前它们没有标题，和新导入的批量任务混在一起时非常容易被忽略。
    const legacyGroupId = '__reels_existing_tasks__';
    let lastBatchGroupId = null;
    let lastFolderQueueId = null;
    container.innerHTML = tasks.map((task, i) => {
        const selected = i === _reelsState.selectedIdx;
        const hasBg = !!(task.bgPath || task.videoPath);
        const hasAudio = !!task.audioPath;
        const hasSrt = !!task.srtPath && (task.segments || []).length > 0;
        const hasTxt = !!task.txtContent;
        const exportChecked = task._exportSelected !== false;

        let statusParts;
        if (workMode === 'voiced_bg') {
            statusParts = [
                hasBg ? '<span style="color:#4ecdc4;">BG</span>' : '<span style="color:#f87171;">BG</span>',
            ];
            if (hasSrt) {
                statusParts.push(`<span style="color:#4ecdc4;">SRT</span>`);
            } else if (hasTxt) {
                statusParts.push(`<span style="color:#ffa502;">TXT</span>`);
            } else {
                statusParts.push('<span style="color:#f87171;">TXT</span>');
            }
        } else if (workMode === 'dubbed_text') {
            statusParts = [
                hasBg ? '<span style="color:#4ecdc4;">BG</span>' : '<span style="color:#f87171;">BG</span>',
                hasAudio ? '<span style="color:#4ecdc4;">VO</span>' : '<span style="color:#f87171;">VO</span>',
            ];
            if (hasSrt) {
                statusParts.push(`<span style="color:#4ecdc4;">SRT</span>`);
            } else if (hasTxt) {
                statusParts.push(`<span style="color:#ffa502;">TXT</span>`);
            } else {
                statusParts.push('<span style="color:#f87171;">TXT</span>');
            }
        } else {
            statusParts = [
                hasBg ? '<span style="color:#4ecdc4;">BG</span>' : '<span style="color:#f87171;">BG</span>',
                hasAudio ? '<span style="color:#4ecdc4;">VO</span>' : '<span style="color:#f87171;">VO</span>',
                hasSrt ? `<span style="color:#4ecdc4;">SRT</span>` : '<span style="color:#f87171;">SRT</span>',
            ];
        }
        const statusText = statusParts.join(' ');
        // 左侧任务列表应优先回显用户在批量表格中设置的“导出命名”。只导入背景
        // 时，card_001 只是系统的临时卡片 ID，不是用户认识的素材名；此时显示
        // 背景文件名，内部 ID 与最终导出命名都不受影响。
        const internalName = String(task.fileName || task.baseName || '');
        const backgroundName = String(task.bgPath || task.videoPath || '').split(/[\\/]/).pop() || '';
        const isGeneratedCardName = /^card_\d+(?:\.[^.]+)?$/i.test(internalName);
        const displayName = String(task.exportName || (isGeneratedCardName && backgroundName ? backgroundName : internalName) || '未命名任务');
        const baseName = displayName.replace(/\.[^.]+$/, '');
        // 左侧列表用于人工找任务：可在“完整名称”和“单行截断”间切换。
        const shortName = baseName;
        const isCompactName = taskNameDisplay === 'compact';
        const taskNameStyle = isCompactName
            ? 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;'
            : 'overflow:visible;text-overflow:clip;white-space:normal;overflow-wrap:anywhere;word-break:break-word;min-width:0;flex:1;';
        const escapeTaskText = (value) => String(value || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        // 覆层内容预览
        let ovPreview = '';
        if (task.overlays && task.overlays.length > 0) {
            const ov0 = task.overlays[0];
            let ovTitle = '', ovBody = '';
            if (ov0.type === 'scroll') {
                ovTitle = (ov0.scroll_title || '').trim();
                ovBody = (ov0.content || '').trim().replace(/\n/g, ' ');
            } else if (ov0.type === 'textcard') {
                ovTitle = (ov0.title_text || '').trim();
                ovBody = (ov0.body_text || '').trim().replace(/\n/g, ' ');
            }
            if (ovTitle || ovBody) {
                const icon = ov0.type === 'scroll' ? '🔄' : '📝';
                const tSnip = ovTitle.length > 12 ? ovTitle.substring(0, 10) + '…' : ovTitle;
                const bSnip = ovBody.length > 20 ? ovBody.substring(0, 18) + '…' : ovBody;
                const parts = [];
                if (tSnip) parts.push(`<b>${escapeTaskText(tSnip)}</b>`);
                if (bSnip) parts.push(escapeTaskText(bSnip));
                ovPreview = `<div style="font-size:10px;color:#8899aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;" title="${escapeTaskText(ovTitle)}\n${escapeTaskText(ovBody)}">${icon} ${parts.join(' | ')}</div>`;
            }
        }

        const capability = _getReelsFastExportCapability(task);
        const exportEngine = (document.getElementById('reels-export-engine') || {}).value || 'precise';
        const fastAlphaEnabled = (document.getElementById('reels-fast-alpha-mode') || {}).checked === true
            || exportEngine === 'pipeline' || exportEngine === 'hardware';

        let alphaIcon = '';
        if (fastAlphaEnabled) {
            if (capability.supported) {
                alphaIcon = `<span title="此任务支持极速背景直通" style="font-size:10px; opacity:0.9;">⚡</span>`;
            } else {
                alphaIcon = `<span title="${escapeTaskText(capability.reason)}；背景回退逐帧渲染" style="font-size:10px; filter:grayscale(1); opacity:0.55;">🐢</span>`;
            }
        }

        // 未选中导出时降低整行不透明度
        const rowOpacity = exportChecked ? '1' : '0.45';

        let batchGroupHeader = '';
        const isLegacyTask = !task._batchTabId;
        const batchGroupId = task._batchTabId || legacyGroupId;
        if (_reelsState.batchGroupCollapsed[batchGroupId] === undefined) _reelsState.batchGroupCollapsed[batchGroupId] = true;
        const batchGroupCollapsed = !!_reelsState.batchGroupCollapsed[batchGroupId];
        if (batchGroupId !== lastBatchGroupId) {
            const groupName = escapeTaskText(isLegacyTask ? '已有任务（未归档）' : (task._batchTabName || '未命名分组'));
            const groupTasks = tasks.filter(item => isLegacyTask ? !item._batchTabId : item._batchTabId === batchGroupId);
            const groupSelected = groupTasks.filter(item => item._exportSelected !== false).length;
            const groupIndeterminate = groupSelected > 0 && groupSelected < groupTasks.length;
            const encodedGroupId = encodeURIComponent(batchGroupId);
            batchGroupHeader = `
                <div class="reels-batch-group-header"
                    style="display:flex;align-items:center;gap:7px;padding:8px 7px;margin:7px 0 3px;
                           border-radius:6px;background:rgba(123,139,239,0.16);border:1px solid rgba(123,139,239,0.35);
                           color:#c7d2fe;font-size:11px;font-weight:700;">
                    <button onclick="event.stopPropagation(); reelsToggleBatchGroup(decodeURIComponent('${encodedGroupId}'))"
                        style="border:none;background:transparent;color:#c7d2fe;cursor:pointer;padding:0;font-size:11px;"
                        title="折叠/展开分组">${batchGroupCollapsed ? '▶' : '▼'}</button>
                    <input type="checkbox" class="reels-batch-group-export-cb" data-indeterminate="${groupIndeterminate ? '1' : '0'}" ${groupSelected === groupTasks.length && groupTasks.length > 0 ? 'checked' : ''}
                        onchange="event.stopPropagation(); reelsToggleBatchGroupExport(decodeURIComponent('${encodedGroupId}'), this.checked)"
                        onclick="event.stopPropagation()"
                        style="accent-color:var(--accent-color,#7b8bef);margin:0;transform:scale(1.08);cursor:pointer;"
                        title="本组总开关：勾选则本组全部参与导出，取消则本组全部不导出">
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${groupName}">${isLegacyTask ? '🕘' : '📑'} ${groupName}</span>
                    <span style="margin-left:auto;color:#94a3b8;font-weight:400;">${groupSelected}/${groupTasks.length}</span>
                </div>`;
            lastFolderQueueId = null;
        }
        lastBatchGroupId = batchGroupId || null;

        let folderHeader = '';
        const queueId = task._folderQueueId || '';
        if (queueId && _reelsState.folderQueueCollapsed[queueId] === undefined) _reelsState.folderQueueCollapsed[queueId] = true;
        const queueCollapsed = queueId ? !!_reelsState.folderQueueCollapsed[queueId] : false;
        if (queueId && queueId !== lastFolderQueueId) {
            const queueName = escapeTaskText(task._folderQueueName || '文件夹队列');
            const queueShortId = _reelsQueueShortId(`folder:${queueId}`);
            const queueTasks = tasks.filter(item => item._folderQueueId === queueId);
            const queueCount = queueTasks.length;
            const queueSelected = queueTasks.filter(item => item._exportSelected !== false).length;
            const queueIndeterminate = queueSelected > 0 && queueSelected < queueCount;
            const encodedQueueId = encodeURIComponent(queueId);
            folderHeader = `
                <div class="reels-folder-queue-header" onclick="reelsToggleFolderQueue(decodeURIComponent('${encodedQueueId}'))"
                    style="display:flex;align-items:center;gap:6px;padding:7px 6px;margin:5px 0 3px;
                           border-radius:6px;background:rgba(76,158,255,0.12);border:1px solid rgba(76,158,255,0.25);
                           color:#9ccaff;cursor:pointer;font-size:11px;font-weight:600;">
                    <span>${queueCollapsed ? '▶' : '▼'}</span>
                    <input type="checkbox" class="reels-folder-queue-export-cb" data-indeterminate="${queueIndeterminate ? '1' : '0'}" ${queueSelected === queueCount && queueCount > 0 ? 'checked' : ''}
                        onchange="event.stopPropagation(); reelsToggleFolderQueueExport(decodeURIComponent('${encodedQueueId}'), this.checked)"
                        onclick="event.stopPropagation()"
                        style="accent-color:var(--accent-color,#7b8bef);margin:0;transform:scale(1.08);cursor:pointer;"
                        title="本账号总开关：勾选则该账号全部任务参与导出，取消则全部不导出">
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${queueName} · 队列唯一编号 Q-${queueShortId}">📁 ${queueName}</span>
                    <span style="flex:0 0 auto;padding:1px 5px;border-radius:999px;background:rgba(76,158,255,.2);border:1px solid rgba(156,202,255,.35);color:#dbeafe;font-size:9px;font-weight:800;" title="队列唯一编号">Q-${queueShortId}</span>
                    <span style="margin-left:auto;color:#789;font-weight:400;">${queueSelected}/${queueCount}</span>
                </div>`;
        }
        lastFolderQueueId = queueId || null;

                 const versionBadge = task.versionTag
                    ? `<span class="reels-version-tag" style="display:inline-block;margin-left:4px;padding:0 5px;font-size:9.5px;line-height:16px;border-radius:3px;background:rgba(245,158,11,0.18);color:#fbbf24;border:1px solid rgba(245,158,11,0.4);font-weight:600;vertical-align:middle;flex-shrink:0;" title="版本说明: ${escapeTaskText(task.versionTag)}">${escapeTaskText(task.versionTag)}</span>`
                    : '';
                 return `${batchGroupHeader}${folderHeader}
            <div class="reels-task-item ${selected ? 'reels-task-selected' : ''}"
                 draggable="true" data-task-idx="${i}"
                 ondragstart="reelsTaskDragStart(event, ${i})"
                 ondragend="reelsTaskDragEnd(event)"
                 onclick="reelsSelectTask(${i})"
                 title="${escapeTaskText(displayName)}${task.versionTag ? ` [版本: ${escapeTaskText(task.versionTag)}]` : ''}${task.exportName && task.fileName ? `\n内部任务名：${escapeTaskText(task.fileName)}` : ''}"
                 style="display:flex; align-items:center; gap:4px; padding:5px 6px; margin-bottom:2px;
                        border-radius:5px; cursor:pointer; transition:background .12s, opacity .15s;
                        background: ${selected ? 'rgba(0,212,255,0.15)' : 'transparent'};
                        border-left: 3px solid ${selected ? '#4c9eff' : 'transparent'};
                        opacity: ${rowOpacity};
                        ${(queueCollapsed || batchGroupCollapsed) ? 'display:none;' : ''}
                        ${selected ? 'box-shadow: inset 0 0 0 1px rgba(0,212,255,0.3);' : ''}">
                <span title="拖动排序" style="color:var(--text-secondary);cursor:grab;font-size:12px;line-height:1;">⠿</span>
                <input type="checkbox" class="reels-export-cb" data-task-idx="${i}" ${exportChecked ? 'checked' : ''}
                    style="accent-color:var(--accent-color,#7b8bef);transform:scale(1.25);margin:0 6px 0 4px;flex-shrink:0;cursor:pointer;"
                    onclick="event.stopPropagation(); reelsToggleExportSelect(${i}, this.checked)"
                    title="勾选以包含在批量导出中">
                <span class="reels-task-name" style="font-size:12px; font-weight:${selected ? '600' : '400'}; color:${selected ? '#fff' : 'var(--text-primary)'}; ${taskNameStyle}">${escapeTaskText(shortName)}</span>${versionBadge}
                ${alphaIcon}
                ${ovPreview}
                ${task.autoEditProject ? `<button class="btn" style="padding:1px 5px;font-size:10px;border:1px solid rgba(134,239,172,.35);background:rgba(74,222,128,.08);color:#86efac;" onclick="event.stopPropagation(); reelsRefreshAutoEditTask(${i})" title="手动用自动剪辑最新成片和字幕更新这条旧任务">更新旧任务</button>` : ''}
                <span style="font-size:10px; white-space:nowrap; opacity:0.8; margin-left:auto;">${statusText}</span>
                <button class="btn reels-task-duplicate-btn" style="padding:1px 4px; font-size:10px; opacity:0.65; border:none; background:transparent; color:#a78bfa; cursor:pointer;" onclick="event.stopPropagation(); reelsDuplicateTask(${i})" title="复制此任务为新版本副本">📋</button>
                <button class="btn" style="padding:1px 4px; font-size:10px; opacity:0.5; border:none; background:transparent; color:var(--text-secondary);" onclick="event.stopPropagation(); reelsRemoveTask(${i})" title="删除">✕</button>
            </div>
        `;
    }).join('');

    container.querySelectorAll('input[type="checkbox"][data-indeterminate="1"]').forEach(cb => {
        cb.indeterminate = true;
    });

    _updateToggleAllGroupsBtnUI();

    if (options && options.preserveScroll) {
        container.scrollTop = prevScrollTop;
    } else {
        // Auto-scroll selected task into view
        const selectedEl = container.querySelector('.reels-task-selected');
        if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function _areAllReelsTaskGroupsCollapsed() {
    const tasks = _reelsState.tasks || [];
    if (tasks.length === 0) return true;
    const legacyGroupId = '__reels_existing_tasks__';
    for (const task of tasks) {
        const batchGroupId = task._batchTabId || legacyGroupId;
        const batchCollapsed = _reelsState.batchGroupCollapsed?.[batchGroupId] !== undefined
            ? !!_reelsState.batchGroupCollapsed[batchGroupId]
            : true;
        if (!batchCollapsed) return false;
        if (task._folderQueueId) {
            const queueCollapsed = _reelsState.folderQueueCollapsed?.[task._folderQueueId] !== undefined
                ? !!_reelsState.folderQueueCollapsed[task._folderQueueId]
                : true;
            if (!queueCollapsed) return false;
        }
    }
    return true;
}

function _updateToggleAllGroupsBtnUI() {
    const btn = document.getElementById('reels-toggle-all-groups-btn');
    if (!btn) return;
    const allCollapsed = _areAllReelsTaskGroupsCollapsed();
    if (allCollapsed) {
        btn.textContent = '▼ 全部展开';
        btn.title = '一键展开全部任务分组与队列';
    } else {
        btn.textContent = '▲ 全部合拢';
        btn.title = '一键合拢全部任务分组与队列';
    }
}

function reelsToggleAllTaskGroups() {
    const tasks = _reelsState.tasks || [];
    if (tasks.length === 0) return;
    const shouldExpand = _areAllReelsTaskGroupsCollapsed();
    const targetCollapsed = !shouldExpand;
    if (!_reelsState.batchGroupCollapsed) _reelsState.batchGroupCollapsed = {};
    if (!_reelsState.folderQueueCollapsed) _reelsState.folderQueueCollapsed = {};
    const legacyGroupId = '__reels_existing_tasks__';
    tasks.forEach(task => {
        const batchGroupId = task._batchTabId || legacyGroupId;
        _reelsState.batchGroupCollapsed[batchGroupId] = targetCollapsed;
        if (task._folderQueueId) {
            _reelsState.folderQueueCollapsed[task._folderQueueId] = targetCollapsed;
        }
    });
    _renderTaskList({ preserveScroll: true });
}
window.reelsToggleAllTaskGroups = reelsToggleAllTaskGroups;

function reelsToggleBatchGroup(groupId) {
    if (!_reelsState.batchGroupCollapsed) _reelsState.batchGroupCollapsed = {};
    _reelsState.batchGroupCollapsed[groupId] = !_reelsState.batchGroupCollapsed[groupId];
    _renderTaskList({ preserveScroll: true });
}
window.reelsToggleBatchGroup = reelsToggleBatchGroup;

function reelsToggleBatchGroupExport(groupId, checked) {
    (_reelsState.tasks || []).forEach(task => {
        if (groupId === '__reels_existing_tasks__' ? !task._batchTabId : task._batchTabId === groupId) {
            task._exportSelected = !!checked;
        }
    });
    _renderTaskList({ preserveScroll: true });
}
window.reelsToggleBatchGroupExport = reelsToggleBatchGroupExport;

// ═══════════════════════════════════════════════════════
// Cover Edit Mode Toggle
// ═══════════════════════════════════════════════════════
function reelsToggleCoverEditMode(enable) {
    _reelsState._coverEditMode = enable;
    
    let coverBanner = document.getElementById('rbt-cover-edit-banner');
    if (!coverBanner) {
        coverBanner = document.createElement('div');
        coverBanner.id = 'rbt-cover-edit-banner';
        coverBanner.style.cssText = 'position:absolute;top:0;left:0;right:0;background:rgba(255,215,0,0.9);color:#000;font-size:12px;font-weight:bold;text-align:center;padding:6px;z-index:99;cursor:pointer;display:none;';
        coverBanner.innerHTML = '✨ 当前处于【封面卡片专属编辑模式】 点击退出';
        coverBanner.onclick = () => reelsToggleCoverEditMode(false);
        const playerArea = document.querySelector('.player-wrapper') || document.querySelector('.preview-player-wrapper') || document.getElementById('reels-preview-canvas').parentElement;
        if (playerArea) {
            playerArea.style.position = 'relative'; 
            playerArea.appendChild(coverBanner);
        }
    }
    if (coverBanner) coverBanner.style.display = enable ? 'block' : 'none';
    
    if (_reelsState.selectedIdx >= 0) {
        reelsSelectTask(_reelsState.selectedIdx);
    }
}

async function _preFetchTaskMediaDurations(task) {
    if (!task) return;
    if (!_reelsState._mediaDurations) _reelsState._mediaDurations = {};
    const paths = [];
    if (task.audioPath && !_reelsState._mediaDurations[task.audioPath]) {
        paths.push(task.audioPath);
    }
    const previewBg = _resolvePreviewBackgroundPath(task);
    if (previewBg.path && !previewBg.isMulti && !_isImagePath(previewBg.path) && !_reelsState._mediaDurations[previewBg.path]) {
        paths.push(previewBg.path);
    }
    if (task.contentVideoPath && !_reelsState._mediaDurations[task.contentVideoPath]) {
        const isSeq = _reelsState.cvSequence && _reelsState.cvSequence.path === task.contentVideoPath;
        if (!isSeq) {
            paths.push(task.contentVideoPath);
        }
    }
    if (paths.length === 0) return;
    if (window.electronAPI && typeof window.electronAPI.getMediaDuration === 'function') {
        for (const p of paths) {
            try {
                const dur = await window.electronAPI.getMediaDuration(p);
                if (dur > 0) {
                    _reelsState._mediaDurations[p] = dur;
                    console.log(`[Preview] Pre-fetched duration for ${p}: ${dur}s`);
                }
            } catch (e) {
                console.error('[Preview] Pre-fetch duration failed for', p, e);
            }
        }
        // 读取媒体元数据是异步的。用户若在此期间切换了任务，不能让旧任务
        // 的回调重建当前时间线，否则预览会显示旧字幕/覆层轨而导出仍使用新任务。
        if (_getSelectedTask() !== task) return;
        _updateTimelineForTask(task);
        _updatePreviewTimeUI(_getPreviewCurrentTime(), _getPreviewDuration());
    }
}

function reelsSelectTask(idx) {
    // ── 保存当前任务的覆层 ──
    const prevTask = _reelsState.tasks[_reelsState.selectedIdx];
    if (prevTask && _reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        if (_reelsState._coverEditMode && prevTask.cover) {
            prevTask.cover.overlays = [...(_reelsState.overlayProxy.overlayMgr.overlays || [])];
        } else {
            prevTask.overlays = [...(_reelsState.overlayProxy.overlayMgr.overlays || [])];
        }
    }

    _reelsState.selectedIdx = idx;
    _renderTaskList();
    const task = _reelsState.tasks[idx];
    if (!task) return;
    _preFetchMultiBgDurations(task);
    _preFetchTaskMediaDurations(task);
    const taskStyle = _resolveSubtitleStyleForTask(task);
    if (taskStyle) _writeStyleToUI(taskStyle);
    if (window.reelsSyncBackgroundTabUI) window.reelsSyncBackgroundTabUI(task);
    _reelsState.previewMultiBg = { taskId: task.id || task.fileName || String(idx), clipIndex: -1, path: '', image: null };
    
    // Sync subtitle preset UI with the selected task. Do not fall back to the
    // default preset here: after manual edits, an empty task preset means the
    // task is using the current custom/global style, not the saved default.
    const presetName = task._subtitlePreset || '';
    const hiddenInput = document.getElementById('reels-preset-select');
    if (hiddenInput) hiddenInput.value = presetName;
    const selectTrigger = document.getElementById('reels-preset-select-trigger');
    if (selectTrigger) {
        const span = selectTrigger.querySelector('span');
        if (span) span.textContent = presetName || '-- 改全部样式 --';
    }

    // ── 加载新任务的覆层 ──
    if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        const mgr = _reelsState.overlayProxy.overlayMgr;
        if (_reelsState._coverEditMode && task.cover) {
            mgr.overlays = task.cover.overlays ? [...task.cover.overlays] : [];
        } else {
            mgr.overlays = task.overlays ? [...task.overlays] : [];
        }
        // 刷新覆层面板
        if (_reelsState.overlayPanel) {
            _reelsState.overlayPanel.deselectOverlay();
            _reelsState.overlayPanel._refreshList();
        }
    }

    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const playBtn = document.getElementById('reels-preview-play');
    const placeholder = document.getElementById('reels-preview-placeholder');
    let previewBg = _resolvePreviewBackgroundPath(task);
    // 编辑覆层预设时的辅助背景只在这一处实时预览使用；不修改 task，
    // 因而不会保存到预设或影响正式导出。
    const overlayPresetPreview = _reelsState._overlayPresetPreviewBackground;
    if (overlayPresetPreview?.path && overlayPresetPreview.taskIndex === _reelsState.selectedIdx) {
        previewBg = { path: overlayPresetPreview.path, isMulti: false, temporary: true };
    }
    const bgPath = previewBg.path;
    // Safety: if bgSrcUrl/srcUrl is a file:// URL that doesn't correspond to the
    // current bgPath, it's stale (left over from a previous file assignment). Clear it
    // so _toPlayablePath generates a fresh URL from the new bgPath.
    let bgSrc = task.bgSrcUrl || task.srcUrl;
    if (bgSrc && bgPath && !bgSrc.startsWith('blob:')) {
        // Decode file:// URL and compare with bgPath
        const decoded = _normalizeLocalMediaPath(bgSrc);
        if (decoded && decoded !== bgPath && decoded !== _normalizeLocalMediaPath(bgPath)) {
            console.log('[Preview] Stale bgSrcUrl detected, clearing. old:', decoded, 'new bgPath:', bgPath);
            task.bgSrcUrl = null;
            task.srcUrl = null;
            bgSrc = null;
        }
    }
    const workMode = _getWorkMode();
    // In voiced_bg mode, the background video IS the audio source
    const voicePath = task.audioPath || (workMode === 'voiced_bg' ? bgPath : '') || '';

    if (audio) {
        audio.pause();
        if (voicePath) {
            const audioUrl = _toPlayablePath(voicePath, null);
            if (audioUrl) {
                if (audio.src !== audioUrl) audio.src = audioUrl;
            } else {
                audio.removeAttribute('src');
            }
        } else {
            audio.removeAttribute('src');
        }
        // 应用音频变速预览：audioDurScale=150% → playbackRate=0.667（减速）
        const aDurScale = task.audioDurScale || 100;
        audio.playbackRate = (aDurScale !== 100) ? (100 / aDurScale) : 1.0;
        audio.preservesPitch = true; // 变速不变调
    }

    // ── 加载 BGM ──
    const bgmAudio = _reelsState._bgmAudioEl;
    if (bgmAudio) {
        bgmAudio.pause();
        const finalBgmPath = _getEffectiveBgmPath(task, _reelsState.selectedIdx);
        if (finalBgmPath) {
            const bgmUrl = _toPlayablePath(finalBgmPath, null);
            if (bgmUrl) {
                if (bgmAudio.src !== bgmUrl) bgmAudio.src = bgmUrl;
            } else {
                bgmAudio.removeAttribute('src');
            }
        } else {
            bgmAudio.removeAttribute('src');
        }
        // 切换任务时，BGM 回到该任务时间轴的起点（不是沿用上一任务的播放位置）。
        try { bgmAudio.currentTime = _getTaskBgmStart(task); } catch (e) { }
    }
    _applyPreviewAudioMix();
    // 同一个 MP3 被多个任务复用时，src 不会变化，浏览器会保留 currentTime。
    // 因此显式归零，保证每次切换任务都从时间轴 0:00 预览。
    if (audio) {
        try { audio.currentTime = 0; } catch (e) { }
    }
    _clearPreviewSeekLock();

    if (video && bgPath && !_reelsFileExists(bgPath)) {
        _reelsState._previewBgImage = null;
        video.pause();
        video.removeAttribute('src');
        _resetPreviewFadeVideo();
        video.style.display = 'none';
        if (placeholder) {
            placeholder.style.display = 'flex';
            placeholder.textContent = `背景素材文件不存在：${bgPath.split(/[\\/]/).pop() || bgPath}`;
        }
    } else if (video && bgPath) {
        if (_isImagePath(bgPath)) {
            video.pause();
            video.removeAttribute('src');
            _resetPreviewFadeVideo();
            video.style.display = 'none';
            // Load image background for canvas rendering
            const imgUrl = _toPlayablePath(bgPath, bgSrc);
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => { _reelsState._previewBgImage = img; };
            img.src = imgUrl;
            _reelsState._previewBgImage = img;
            if (placeholder) {
                placeholder.style.display = 'none';
            }
            if (previewBg.isMulti) {
                console.log('[Preview] 多素材模式预览使用素材池代表帧:', bgPath);
            }
        } else {
            _reelsState._previewBgImage = null; // Clear image bg
            const filePath = _toPlayablePath(bgPath, bgSrc);
            // 总是重新设置 src（避免 URL 规范化导致比较失误）
            video.pause();
            video.src = filePath;
            video.load();
            // 强制加载第一帧 — seek 到 0.01s 触发帧数据加载
            video.addEventListener('loadeddata', function _onLoaded() {
                video.removeEventListener('loadeddata', _onLoaded);
                console.log('[Preview] Video loadeddata, readyState:', video.readyState);
            }, { once: true });
            try { video.currentTime = 0.01; } catch (e) { }
            const fadeVideo = _ensurePreviewFadeVideo(video);
            if (fadeVideo) {
                fadeVideo.pause();
                try { fadeVideo.currentTime = 0; } catch (e) { }
            }
            _ensurePreviewVideoDecodable(video);
            if (placeholder) {
                placeholder.style.display = 'none';
                placeholder.textContent = '选择视频任务后可实时预览字幕效果';
            }
            if (previewBg.isMulti) {
                console.log('[Preview] 多素材模式预览使用素材池代表视频:', bgPath);
            }
        }
    } else if (video) {
        _reelsState._previewBgImage = null; // Clear image bg
        video.pause();
        video.removeAttribute('src');
        _resetPreviewFadeVideo();
        video.style.display = 'none';
        if (placeholder) {
            placeholder.style.display = (task.contentVideoDirectBg || task.contentVideoBlurBg) && task.contentVideoPath ? 'none' : 'flex';
            placeholder.textContent = '当前任务没有背景素材，预览将显示纯色底。';
        }
    }

    // ── 加载 Hook 视频 ──
    // 与导出一致：task.hookFile 优先，回退到全局前置路径
    const hookVideo = document.getElementById('reels-preview-hook-video');
    const globalIntroPath = (document.getElementById('reels-intro-path') || {}).value || '';
    // Hook 文件解析链：task.hookFile → task.hook.path → 全局前置路径（可显式禁用）
    let effectiveHookFile = _resolveTaskHookPath(task, globalIntroPath);
    // 验证文件存在（防止残留路径导致假 hook 阶段）
    if (effectiveHookFile && window.require) {
        try {
            const fs = window.require('fs');
            if (!fs.existsSync(effectiveHookFile)) {
                console.warn(`[Preview] Hook file not found, clearing: ${effectiveHookFile}`);
                effectiveHookFile = '';
            }
        } catch (e) { /* ignore */ }
    }
    if (hookVideo) {
        hookVideo.pause();
        _reelsState.hookVideoReady = false;
        _reelsState.hookDuration = 0;
        _reelsState.hookPhase = false;

        if (effectiveHookFile) {
            const hookUrl = _toPlayablePath(effectiveHookFile, null);
            hookVideo.src = hookUrl;
            hookVideo.playbackRate = task.hookSpeed || 1.0;
            _ensurePreviewVideoDecodable(hookVideo);
            hookVideo.load();
            hookVideo.onloadedmetadata = () => {
                let dur = hookVideo.duration || 0;
                // Apply trim（与导出 concatVideo 一致）
                const trimStart = (task.hookTrimStart != null && task.hookTrimStart > 0) ? task.hookTrimStart : 0;
                const trimEnd = (task.hookTrimEnd != null && task.hookTrimEnd > 0) ? task.hookTrimEnd : dur;
                dur = Math.max(0, trimEnd - trimStart);
                // Apply speed（与导出 concatVideo 一致）
                const speed = task.hookSpeed || 1.0;
                dur = dur / speed;
                _reelsState.hookDuration = dur;
                _reelsState.hookVideoReady = true;
                hookVideo.currentTime = trimStart || 0.01;
                console.log(`[Preview] Hook video loaded, duration: ${dur.toFixed(2)}s (raw: ${hookVideo.duration}s, trim: ${trimStart}-${trimEnd}, speed: ${speed}x)`);
                _updatePreviewTimeUI(0, _getPreviewDuration());
            };
            // 强制在 trimEnd 处停止（防止播放超出裁剪范围，与导出 FFmpeg 裁剪一致）
            hookVideo.ontimeupdate = () => {
                const trimEnd = (task.hookTrimEnd != null && task.hookTrimEnd > 0) ? task.hookTrimEnd : Infinity;
                if (hookVideo.currentTime >= trimEnd) {
                    hookVideo.pause();
                }
            };
        } else {
            hookVideo.removeAttribute('src');
            hookVideo.ontimeupdate = null;
        }
    }

    const cvVideo = document.getElementById('reels-preview-contentvideo');
    _reelsState.previewContentImage = null; // reset
    if (cvVideo) {
        if (task.contentVideoPath) {
            const cvRawPath = _normalizeLocalMediaPath(task.contentVideoPath);
            let isDir = false;
            if (window.require) {
                const fs = window.require('fs');
                if (fs.existsSync(cvRawPath) && fs.statSync(cvRawPath).isDirectory()) {
                    isDir = true;
                    if (_reelsState.cvSequence.path !== cvRawPath) {
                        _reelsState.cvSequence.path = cvRawPath;
                        _reelsState.cvSequence.files = fs.readdirSync(cvRawPath)
                            .filter(f => !f.startsWith('.') && /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
                        _reelsState.cvSequence.loadedImages = {};

                        const path = window.require('path');
                        for (const f of _reelsState.cvSequence.files) {
                            const img = new Image();
                            img.src = _toPlayablePath(path.join(cvRawPath, f), null);
                            _reelsState.cvSequence.loadedImages[f] = img;
                        }
                    }
                    cvVideo.pause();
                    cvVideo.removeAttribute('src');
                }
            }

            if (!isDir) {
                if (_isImagePath(cvRawPath)) {
                    const img = new Image();
                    img.onload = () => { _reelsState.previewContentImage = img; };
                    img.src = _toPlayablePath(cvRawPath, null);
                    cvVideo.pause();
                    cvVideo.removeAttribute('src');
                } else {
                    const cvPath = _toPlayablePath(cvRawPath || task.contentVideoPath, null);
                    if (cvVideo.src !== cvPath) {
                        cvVideo.pause();
                        cvVideo.src = cvPath;
                        _ensurePreviewVideoDecodable(cvVideo);
                        cvVideo.load();
                    }
                    _ensurePreviewVideoDecodable(cvVideo);
                    const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
                    try {
                        if (Math.abs((cvVideo.currentTime || 0) - trimStart) > 0.2) {
                            cvVideo.currentTime = trimStart;
                        }
                    } catch (e) { }
                }
            }
        } else {
            cvVideo.pause();
            cvVideo.removeAttribute('src');
            try { cvVideo.load(); } catch (e) { }
        }
        // 设置覆层视频音量（预览+导出）
        const cvVol = task.contentVideoVolume != null ? task.contentVideoVolume : 100;
        if (_reelsState._audioCtx && _reelsState._gainNodes?.has(cvVideo)) {
            cvVideo.volume = cvVol > 0 ? 1.0 : 0;
            cvVideo.muted = cvVol <= 0.001;
        } else {
            cvVideo.volume = Math.min(1.0, cvVol / 100);
            cvVideo.muted = cvVol <= 0.001;
        }
    }

    // ── 加载 Cover 素材 ──
    _reelsState._previewCoverImage = null;
    if (_reelsState._previewCoverVideo && _reelsState._previewCoverVideo.parentNode) {
        try { _reelsState._previewCoverVideo.parentNode.removeChild(_reelsState._previewCoverVideo); } catch (e) { }
    }
    _reelsState._previewCoverVideo = null;
    if (task.cover && task.cover.bgPath) {
        const cPath = task.cover.bgPath;
        const isVideo = /\.(mp4|mov|mkv|webm)$/i.test(cPath);
        if (isVideo) {
            const vid = document.createElement('video');
            vid.crossOrigin = 'anonymous';
            vid.muted = true;
            vid.src = _toPlayablePath(cPath, null);
            _ensurePreviewVideoDecodable(vid);
            vid.load();
            vid.onloadeddata = () => { vid.currentTime = 0.05; };
            _reelsState._previewCoverVideo = vid; // Store dynamically created cover video
        } else {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = _toPlayablePath(cPath, null);
            _reelsState._previewCoverImage = img;
        }
    }

    const previewText = document.getElementById('reels-preview-text');
    if (previewText && Array.isArray(task.segments) && task.segments.length > 0) {
        previewText.value = task.segments[0].text;
    }

    _updateTimelineForTask(task);
    _applyPreviewLoopMode();
    _reelsState.mockPlaying = false;
    _reelsState.mockPausedTime = 0;
    _updatePreviewTimeUI(0, _getPreviewDuration());
    // V2 预览有独立时钟；播放中切换任务时也必须清掉旧任务进度。
    window.ReelsPreviewV2?.resetForTaskSwitch?.();
    if (playBtn) playBtn.textContent = '▶️';
}

function reelsRemoveTask(idx) {
    if (idx < 0 || idx >= _reelsState.tasks.length) return;
    const prevSelectedIdx = _reelsState.selectedIdx;
    const removed = _reelsState.tasks.splice(idx, 1);

    if (typeof window.reelsSyncTaskRemovalToBatchTabs === 'function') {
        window.reelsSyncTaskRemovalToBatchTabs(removed);
    } else if (typeof _batchAutoSave === 'function') {
        _batchAutoSave();
    }

    if (_reelsState.tasks.length === 0) {
        _reelsState.selectedIdx = -1;
        _renderTaskList();

        _reelsState._previewBgImage = null;
        const video = document.getElementById('reels-preview-video');
        const audio = document.getElementById('reels-preview-audio');
        const playBtn = document.getElementById('reels-preview-play');
        const placeholder = document.getElementById('reels-preview-placeholder');
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.style.display = 'none';
        }
        if (audio) {
            audio.pause();
            audio.removeAttribute('src');
        }
        _resetPreviewFadeVideo();
        if (placeholder) {
            placeholder.style.display = 'flex';
            placeholder.textContent = '选择任务以预览';
        }
        if (playBtn) playBtn.textContent = '▶️';
        _updatePreviewTimeUI(0, 0);
        return;
    }

    // 维护删除后的选中索引
    let nextSelectedIdx = prevSelectedIdx;
    if (prevSelectedIdx === idx) {
        nextSelectedIdx = Math.min(idx, _reelsState.tasks.length - 1);
    } else if (prevSelectedIdx > idx) {
        nextSelectedIdx = prevSelectedIdx - 1;
    }
    _reelsState.selectedIdx = Math.max(0, Math.min(nextSelectedIdx, _reelsState.tasks.length - 1));

    // 统一走选择逻辑，确保预览背景/音频/时间线同步
    reelsSelectTask(_reelsState.selectedIdx);
}

async function reelsDuplicateTask(idx, versionTagInput) {
    if (idx < 0 || idx >= (_reelsState?.tasks || []).length) return null;
    const srcTask = _reelsState.tasks[idx];
    if (!srcTask) return null;

    let versionTag = versionTagInput;
    if (versionTag === undefined || versionTag === null) {
        const promptFn = window.reelsPrompt || window._bcPrompt;
        if (typeof promptFn === 'function') {
            const res = await promptFn('请输入副本版本说明（例如 Hook-B、短版、变体A）', '副本');
            if (res === null) return null;
            versionTag = res.trim() || '副本';
        } else if (typeof prompt === 'function') {
            const res = prompt('请输入副本版本说明（例如 Hook-B、短版、变体A）', '副本');
            if (res === null) return null;
            versionTag = res.trim() || '副本';
        } else {
            versionTag = '副本';
        }
    }

    const cloned = JSON.parse(JSON.stringify(srcTask));
    if (window.ReelsTaskDerivation?.rekeyTask) {
        window.ReelsTaskDerivation.rekeyTask(cloned);
    } else {
        cloned.id = 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    }

    cloned.versionTag = versionTag;
    if (cloned.exportName) {
        cloned.exportName = `${cloned.exportName}_${versionTag}`;
    }
    if (cloned.fileName && !cloned.exportName) {
        const parts = cloned.fileName.split('.');
        const ext = parts.length > 1 ? '.' + parts.pop() : '';
        cloned.fileName = `${parts.join('.')}_${versionTag}${ext}`;
    }

    const insertIdx = idx + 1;
    _reelsState.tasks.splice(insertIdx, 0, cloned);
    _renderTaskList();
    if (typeof _renderBatchTable === 'function') _renderBatchTable();
    reelsSelectTask(insertIdx);
    if (typeof reelsSaveHistory === 'function') reelsSaveHistory();
    if (typeof showToast === 'function') {
        showToast(`已复制任务副本（${versionTag}）`, 'success');
    }
    return cloned;
}
window.reelsDuplicateTask = reelsDuplicateTask;

async function reelsDuplicateSelectedTasks(versionTagInput) {
    const tasks = _reelsState?.tasks || [];
    if (!tasks.length) {
        if (typeof showToast === 'function') showToast('任务列表为空', 'warning');
        return [];
    }

    const selectedIndices = [];
    tasks.forEach((t, i) => {
        if (t._exportSelected !== false) {
            selectedIndices.push(i);
        }
    });

    if (!selectedIndices.length) {
        if (typeof showToast === 'function') showToast('请先勾选需要复制的任务', 'warning');
        return [];
    }

    let versionTag = versionTagInput;
    if (versionTag === undefined || versionTag === null) {
        const promptFn = window.reelsPrompt || window._bcPrompt;
        if (typeof promptFn === 'function') {
            const res = await promptFn(`请输入选中的 ${selectedIndices.length} 个任务的副本版本说明（例如 Hook-B、短版）`, '副本');
            if (res === null) return [];
            versionTag = res.trim() || '副本';
        } else if (typeof prompt === 'function') {
            const res = prompt(`请输入选中的 ${selectedIndices.length} 个任务的副本版本说明（例如 Hook-B、短版）`, '副本');
            if (res === null) return [];
            versionTag = res.trim() || '副本';
        } else {
            versionTag = '副本';
        }
    }

    const newTasks = [];
    selectedIndices.forEach(idx => {
        const srcTask = tasks[idx];
        if (!srcTask) return;
        const cloned = JSON.parse(JSON.stringify(srcTask));
        if (window.ReelsTaskDerivation?.rekeyTask) {
            window.ReelsTaskDerivation.rekeyTask(cloned);
        } else {
            cloned.id = 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
        }
        cloned.versionTag = versionTag;
        if (cloned.exportName) {
            cloned.exportName = `${cloned.exportName}_${versionTag}`;
        }
        if (cloned.fileName && !cloned.exportName) {
            const parts = cloned.fileName.split('.');
            const ext = parts.length > 1 ? '.' + parts.pop() : '';
            cloned.fileName = `${parts.join('.')}_${versionTag}${ext}`;
        }
        cloned._exportSelected = true;
        newTasks.push(cloned);
    });

    const lastIdx = selectedIndices[selectedIndices.length - 1];
    _reelsState.tasks.splice(lastIdx + 1, 0, ...newTasks);

    _renderTaskList();
    if (typeof _renderBatchTable === 'function') _renderBatchTable();
    reelsSelectTask(lastIdx + 1);
    if (typeof reelsSaveHistory === 'function') reelsSaveHistory();
    if (typeof showToast === 'function') {
        showToast(`已批量复制 ${newTasks.length} 个任务副本（${versionTag}）`, 'success');
    }
    return newTasks;
}
window.reelsDuplicateSelectedTasks = reelsDuplicateSelectedTasks;

// ═══════════════════════════════════════════════════════
// Video preview controls
function reelsTogglePlay() {
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const hookVideo = document.getElementById('reels-preview-hook-video');
    const fadeVideo = _reelsState.previewFadeVideo;
    const btn = document.getElementById('reels-preview-play');
    const task = _getSelectedTask();
    _applyPreviewAudioMix();
    _applyPreviewLoopMode();

    const hasAudio = !!(task && task.audioPath && audio && audio.src);
    const previewBg = _resolvePreviewBackgroundPath(task);
    const hasVideo = !!(task && !previewBg.isMulti && previewBg.path && !_isImagePath(previewBg.path) && video && video.src && !(task.contentVideoDirectBg && task.contentVideoPath));
    // 与导出一致：task.hookFile 优先，全局前置回退
    const hasHook = !!(hookVideo && hookVideo.src && _reelsState.hookDuration > 0);
    const master = _getPreviewMasterElement();
    const hasMedia = !!master;
    const hookPlaying = hookVideo && !hookVideo.paused;

    // ── BGM 音频元素 ──
    const bgmAudio = _reelsState._bgmAudioEl;
    const isPlaying = _isPreviewActuallyPlaying(master, hookVideo, bgmAudio);

    if (isPlaying) {
        const savedTime = _getPreviewPlaybackTimeForPause();
        if (master) {
            if (audio) audio.pause();
            if (video) video.pause();
            if (fadeVideo) fadeVideo.pause();
        }
        // 覆层视频也要暂停
        const cvEl = document.getElementById('reels-preview-contentvideo');
        if (cvEl && !cvEl.paused) cvEl.pause();
        _reelsState.mockPlaying = false;
        _reelsState.mockPausedTime = savedTime;
        if (hookVideo) hookVideo.pause();
        if (bgmAudio) bgmAudio.pause();
        if (btn) btn.textContent = '▶️';
        return;
    }

    // 回到开头：如果当前时间已经到了或超过了总时长
    const curT = _getPreviewCurrentTime();
    const durT = _getPreviewDuration();

    if (durT > 0 && curT >= durT - 0.05) {
        if (hasAudio) audio.currentTime = 0;
        if (hasVideo) video.currentTime = 0;
        if (hasHook) {
            const trimStart = (task.hookTrimStart != null && task.hookTrimStart > 0) ? task.hookTrimStart : 0;
            hookVideo.currentTime = trimStart || 0.01;
        }
        _reelsState.mockPausedTime = 0;
    }

    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    
    const inCoverPhase = coverDur > 0 && curT < coverDur;
    const inHookPhase = hookDur > 0 && curT >= coverDur && curT < (coverDur + hookDur);

    if (inCoverPhase) {
        if (hasHook && hookVideo) hookVideo.pause();
        _reelsState.mockPlaying = true;
        _reelsState.mockStartTime = (performance.now() / 1000) - (_reelsState.mockPausedTime || curT);
    } else if (hasHook && inHookPhase) {
        // ── Hook 阶段：先播放 Hook 视频 ──
        hookVideo.playbackRate = task.hookSpeed || 1.0;
        hookVideo.play().catch(() => { });

        // 同时启用 mock 时钟来驱动总时间
        _reelsState.mockPlaying = true;
        _reelsState.mockStartTime = (performance.now() / 1000) - (_reelsState.mockPausedTime || curT);

        // 主音视频暂不播放（Hook 结束后由 _syncHookPhaseTransition 启动）
        if (!hasMedia) {
            // 就用 mock 时钟
        }
    } else {
        // ── 正片阶段：正常播放 ──
        if (hasHook && hookVideo) hookVideo.pause();

        if (!hasMedia) {
            _reelsState.mockPlaying = true;
            _reelsState.mockStartTime = (performance.now() / 1000) - (_reelsState.mockPausedTime || 0);
        } else {
            if (hasAudio && audio && task && task.audioPath) {
                // 应用音频变速：audioDurScale=150% → playbackRate=0.667
                const aDurScale = task.audioDurScale || 100;
                audio.playbackRate = (aDurScale !== 100) ? (100 / aDurScale) : 1.0;
                audio.preservesPitch = true;
                audio.play().catch(() => { });
            }
            if (hasVideo && video) {
                // 应用视频变速：bgDurScale=150% → playbackRate=0.667
                const bDurScale = (task && task.bgDurScale) || 100;
                video.playbackRate = (bDurScale !== 100) ? (100 / bDurScale) : 1.0;
                
                const vDur = _getVideoDuration(task);
                if (hasAudio && task && task.audioPath && vDur > 0) {
                    try { video.currentTime = (audio.currentTime || 0) % vDur; } catch (e) { }
                }
                video.play().catch(() => { });
                if (fadeVideo && hasAudio && task && task.audioPath) {
                    fadeVideo.playbackRate = video.playbackRate;
                    fadeVideo.play().catch(() => { });
                }
            }
            // 覆层视频作为 master 时也要启动播放
            const cvEl = document.getElementById('reels-preview-contentvideo');
            if (cvEl && cvEl.src && cvEl.paused) {
                cvEl.play().catch(() => { });
            }
        }
    }

    // ── 同步播放 BGM (仅正片阶段) ──
    if (!inHookPhase && bgmAudio && bgmAudio.src && task && _getEffectiveBgmPath(task, _reelsState.selectedIdx)) {
        const bgmTime = _getTaskBgmStart(task) + (_getPreviewCurrentTime() || 0);
        bgmAudio.currentTime = bgmAudio.duration > 0 ? bgmTime % bgmAudio.duration : bgmTime;
        bgmAudio.play().catch(() => { });
    }
    _clearPreviewSeekLock();
    if (btn) btn.textContent = '⏸️';
}

/**
 * Hook → Main 阶段自动切换
 * 在 reelsUpdatePreview 循环中调用，检测 Hook 结束后自动启动主音视频
 * 与导出的 FFmpeg xfade 行为一致：有转场时，正片在 transitionDur 前就开始播放
 */
function _syncHookPhaseTransition() {
    const curT = _getPreviewCurrentTime();
    const task = _getSelectedTask();
    if (!task) return;

    const hookVideo = document.getElementById('reels-preview-hook-video');
    const coverDur = (task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const hookDur = _reelsState.hookDuration || 0;
    
    if (coverDur <= 0 && hookDur <= 0) return;

    const inHookPhase = hookDur > 0 && curT >= coverDur && curT < (coverDur + hookDur);
    const inMainPhase = curT >= (coverDur + hookDur);

    if (_reelsState.mockPlaying) {
        // 进入 Hook 阶段
        if (inHookPhase && hookVideo && hookVideo.paused) {
            hookVideo.playbackRate = task.hookSpeed || 1.0;
            hookVideo.play().catch(() => { });
        }
        
        // 进入 主视频 阶段
        if (inMainPhase) {
            if (hookVideo && !hookVideo.paused) hookVideo.pause();

            _reelsState.mockPlaying = false;
            _reelsState.hookPhase = false;
            _reelsState.coverPhase = false;

            const audio = document.getElementById('reels-preview-audio');
        const video = document.getElementById('reels-preview-video');
        const fadeVideo = _reelsState.previewFadeVideo;
        const hasAudio = !!(task && task.audioPath && audio && audio.src);
        const previewBg = _resolvePreviewBackgroundPath(task);
        const hasVideo = !!(task && !previewBg.isMulti && previewBg.path && !_isImagePath(previewBg.path) && video && video.src && !(task.contentVideoDirectBg && task.contentVideoPath));

        const hookTransition = task.hookTransition || 'none';
        const transDur = hookTransition !== 'none' ? (task.hookTransDuration || 0.5) : 0;

        if (hasAudio && audio) {
            // 有转场时，正片从转场重叠量开始（与 FFmpeg acrossfade 一致）
            audio.currentTime = transDur > 0 ? Math.min(transDur, _getAudioDuration(task) || 0) : 0;
            const aDurScale = task.audioDurScale || 100;
            audio.playbackRate = (aDurScale !== 100) ? (100 / aDurScale) : 1.0;
            audio.preservesPitch = true;
            audio.play().catch(() => { });
        }
        if (hasVideo && video) {
            const bDurScale = task.bgDurScale || 100;
            video.playbackRate = (bDurScale !== 100) ? (100 / bDurScale) : 1.0;
            video.currentTime = 0;
            video.play().catch(() => { });
            if (fadeVideo && hasAudio) {
                fadeVideo.playbackRate = video.playbackRate;
                fadeVideo.play().catch(() => { });
            }
        }

        // 覆层视频作为 master 时也要启动播放
        const cvEl = document.getElementById('reels-preview-contentvideo');
        if (cvEl && cvEl.src && cvEl.paused) {
            cvEl.currentTime = 0;
            cvEl.play().catch(() => { });
        }

        // 没有主媒体时，继续使用 mock 时钟
        const hasCvMaster = !!(cvEl && cvEl.src && !cvEl.muted);
        if (!hasAudio && !hasVideo && !hasCvMaster) {
            _reelsState.mockPlaying = true;
            // mockStartTime 不需要重设，因为总时间是连续的
        }

        // 启动 BGM
        const bgmAudio = _reelsState._bgmAudioEl;
        if (bgmAudio && bgmAudio.src && task && _getEffectiveBgmPath(task, _reelsState.selectedIdx)) {
            bgmAudio.currentTime = bgmAudio.duration > 0 ? _getTaskBgmStart(task) % bgmAudio.duration : _getTaskBgmStart(task);
            bgmAudio.play().catch(() => { });
        }

        console.log(`[Preview] Hook phase ended (transition: ${hookTransition}, transDur: ${transDur}s), starting main content`);
        }
    }
}

function _isPreviewSeekLocked() {
    const lock = _reelsState.previewSeekLock;
    return !!(lock && Number.isFinite(lock.target) && performance.now() < lock.until);
}

function _clearPreviewSeekLock(token) {
    if (!_reelsState.previewSeekLock) return;
    if (token != null && _reelsState.previewSeekLock.token !== token) return;
    _reelsState.previewSeekLock = null;
}

function _isPreviewVideoElement(media) {
    return !!(media && media.tagName && String(media.tagName).toLowerCase() === 'video');
}

function _queuePreviewMediaSeek(seekedMedia, media, target) {
    if (!media || !media.src || !Number.isFinite(target)) return false;

    delete media._reelsSeekFrameCanvas;
    delete media._reelsSeekFrameSrc;
    delete media._reelsSeekFrameToken;
    delete media._reelsSeekFrameTarget;
    const item = {
        media,
        target,
        wasPaused: !!media.paused,
        isVideo: _isPreviewVideoElement(media),
    };
    seekedMedia.push(item);
    try {
        if (item.isVideo) _ensurePreviewVideoDecodable(media);
        media.currentTime = target;
        return true;
    } catch (err) {
        seekedMedia.pop();
        return false;
    }
}

function _primePreviewVideoFrame(item, refresh, token, doneCallback = null) {
    const media = item && item.media;
    const done = () => {
        if (typeof doneCallback === 'function') doneCallback();
    };
    if (!media || !item.isVideo || !media.src) {
        done();
        return;
    }

    const isSuperseded = () => token != null && media._reelsSeekPrimeToken !== token;
    media._reelsSeekPrimeToken = token;

    const finish = () => {
        if (isSuperseded()) {
            done();
            return;
        }
        refresh();
        done();
    };

    const primeFrame = () => {
        if (isSuperseded()) {
            done();
            return;
        }
        // Check if preview is playing via the play/pause toggle button text
        const playBtn = document.getElementById('reels-preview-play');
        const isPlayingNow = playBtn && playBtn.textContent === '⏸️';
        if (isPlayingNow || !media.paused) {
            finish();
            return;
        }
        const wasMuted = media.muted;
        media.muted = true;
        media._reelsSeekPriming = true;
        media.play()
            .then(() => {
                const stillPlaying = playBtn && playBtn.textContent === '⏸️';
                if (!stillPlaying) {
                    media.pause();
                }
                media.muted = wasMuted;
                delete media._reelsSeekPriming;
                finish();
            })
            .catch(() => {
                const stillPlaying = playBtn && playBtn.textContent === '⏸️';
                if (!stillPlaying) {
                    media.pause();
                }
                media.muted = wasMuted;
                delete media._reelsSeekPriming;
                finish();
            });
    };

    let completed = false;
    const complete = () => {
        if (completed) return;
        completed = true;
        media.removeEventListener('seeked', complete);
        primeFrame();
    };

    if (media.seeking) {
        media.addEventListener('seeked', complete, { once: true });
        // Fallback in case seeked gets lost
        setTimeout(complete, 150);
    } else {
        requestAnimationFrame(complete);
    }
}

function _mapAbsoluteTimeToTimelineTime(absoluteTime) {
    const task = _getSelectedTask();
    if (!task) return absoluteTime;
    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const offsetDur = hookDur + coverDur;
    const aDurScale = task.audioDurScale ? (task.audioDurScale / 100) : 1;
    return Math.max(0, (absoluteTime - offsetDur) / aDurScale);
}

function _refreshPreviewAfterSeek(target, duration, seekTargets = [], token = null, options = {}) {
    _updatePreviewTimeUI(target, duration);
    if (_reelsState.timelineEditor) {
        _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(target));
    }

    const refresh = () => {
        _updatePreviewTimeUI(target, duration);
        if (_reelsState.timelineEditor) {
            _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(target));
        }
        reelsUpdatePreview();
    };

    refresh();
    requestAnimationFrame(refresh);
    setTimeout(refresh, 60);
    setTimeout(refresh, 160);

    const validTargets = seekTargets
        .map((item) => item && item.media ? item : { media: item, target: null, wasPaused: item ? !!item.paused : true, isVideo: _isPreviewVideoElement(item) })
        .filter((item) => item && item.media && item.media.src);

    if (options.deferFramePrime) {
        clearTimeout(_reelsState._previewSeekPrimeTimer);
        _reelsState._previewSeekPrimeTimer = setTimeout(() => {
            if (!_reelsState.previewSeekLock || _reelsState.previewSeekLock.token !== token) return;
            _refreshPreviewAfterSeek(target, duration, validTargets, token, { deferFramePrime: false });
        }, 120);
        setTimeout(() => _clearPreviewSeekLock(token), 2200);
        return;
    }

    let pending = validTargets.length;
    let released = false;
    const releaseOne = () => {
        pending -= 1;
        if (!released && pending <= 0) {
            released = true;
            setTimeout(() => _clearPreviewSeekLock(token), 80);
        }
    };

    for (const item of validTargets) {
        const media = item.media;
        const mediaTarget = item.target;
        if (!media || !media.src) continue;
        media.addEventListener('seeked', refresh, { once: true });
        media.addEventListener('loadeddata', refresh, { once: true });
        media.addEventListener('canplay', refresh, { once: true });
        if (typeof media.requestVideoFrameCallback === 'function') {
            try { media.requestVideoFrameCallback(refresh); } catch (e) { }
        }

        let tries = 0;
        const pollSeek = () => {
            tries += 1;
            const wantsTarget = Number.isFinite(mediaTarget);
            const notAtTarget = wantsTarget && Math.abs((media.currentTime || 0) - mediaTarget) > 0.06;
            if ((media.seeking || notAtTarget) && tries < 24) {
                requestAnimationFrame(pollSeek);
                return;
            }
            refresh();
            _primePreviewVideoFrame(item, refresh, token, releaseOne);
        };
        requestAnimationFrame(pollSeek);
    }

    if (validTargets.length === 0) {
        setTimeout(() => _clearPreviewSeekLock(token), 180);
    } else {
        setTimeout(() => _clearPreviewSeekLock(token), 1800);
    }
}

let _onSeekThrottleTimer = null;
let _onSeekPendingEvent = null;
let _onSeekLastTime = 0;

function _onSeek(e) {
    const isDrag = e && (e.type === 'mousemove' || e.type === 'input');
    const isClickOrRelease = !isDrag;
    _onSeekPendingEvent = e;
    
    const now = performance.now();
    const elapsed = now - _onSeekLastTime;
    const throttleMs = 60; // 60ms throttle (approx 16fps)
    
    if (isClickOrRelease || elapsed >= throttleMs) {
        if (_onSeekThrottleTimer) {
            clearTimeout(_onSeekThrottleTimer);
            _onSeekThrottleTimer = null;
        }
        _executeSeekNow();
    } else {
        if (!_onSeekThrottleTimer) {
            _onSeekThrottleTimer = setTimeout(() => {
                _onSeekThrottleTimer = null;
                _executeSeekNow();
            }, throttleMs - elapsed);
        }
    }
}

function _executeSeekNow() {
    const e = _onSeekPendingEvent;
    if (!e) return;
    _onSeekPendingEvent = null;
    _onSeekLastTime = performance.now();
    _actualSeek(e);
}

function _actualSeek(e) {
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const hookVideo = document.getElementById('reels-preview-hook-video');
    const duration = _getPreviewDuration() || (_reelsState.timelineEditor && _reelsState.timelineEditor._duration) || 0;
    
    let target = 0;
    if (e && typeof e.absoluteTarget === 'number') {
        target = e.absoluteTarget;
    } else {
        const rawValue = e && e.target ? parseFloat(e.target.value) : NaN;
        if (!Number.isFinite(rawValue)) return;
        target = (rawValue / 100) * duration;
    }
    const task = _getSelectedTask();
    console.log(`[Seek] target=${target.toFixed(3)}s, duration=${duration.toFixed(3)}s, audioPath=${task?.audioPath ? 'yes' : 'no'}, bgPath=${task?.bgPath ? 'yes' : 'no'}, cvPath=${task?.contentVideoPath ? 'yes' : 'no'}`);

    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const seekInCoverPhase = coverDur > 0 && target < coverDur;
    const seekInHookPhase = hookDur > 0 && target >= coverDur && target < (coverDur + hookDur);
    const seekedMedia = [];
    const seekToken = ((_reelsState.previewSeekLock && _reelsState.previewSeekLock.token) || 0) + 1;
    const deferFramePrime = false;

    // 必须始终更新 mock 时间，以保证在暂停状态下拖动时，时钟立即同步更新
    _reelsState.mockPausedTime = target;
    _reelsState.mockStartTime = (performance.now() / 1000) - target;
    _reelsState.coverPhase = seekInCoverPhase;
    _reelsState.hookPhase = seekInHookPhase;
    _reelsState.previewSeekLock = {
        target,
        token: seekToken,
        until: performance.now() + 1800,
    };

    // ── Cover video seek ──
    const coverVideo = _reelsState._previewCoverVideo;
    if (coverVideo && coverVideo.src && seekInCoverPhase) {
        const coverTarget = coverVideo.duration > 0 ? Math.min(target, Math.max(0, coverVideo.duration - 0.03)) : target;
        _queuePreviewMediaSeek(seekedMedia, coverVideo, coverTarget);
    }

    // ── Hook video seek ──
    if (hookVideo && hookVideo.src && hookDur > 0) {
        if (seekInHookPhase) {
            const trimStart = (task && task.hookTrimStart != null && task.hookTrimStart > 0) ? task.hookTrimStart : 0;
            const speed = (task && task.hookSpeed) || 1.0;
            const hookTarget = trimStart + ((target - coverDur) * speed);
            _queuePreviewMediaSeek(seekedMedia, hookVideo, hookTarget);
        } else {
            if (!hookVideo.paused) hookVideo.pause();
        }
    }

    // ── Main content seek (offset by hookDur + coverDur) ──
    const contentTarget = hookDur > 0 || coverDur > 0 ? Math.max(0, target - hookDur - coverDur) : target;

    const aDur = _getAudioDuration(task);
    if (task && task.audioPath && audio && audio.src && aDur > 0) {
        const aDurScale = task.audioDurScale ? (task.audioDurScale / 100) : 1;
        const audioTarget = Math.max(0, Math.min(contentTarget / Math.max(aDurScale, 0.0001), aDur));
        console.log(`[Seek] Seeking Audio to ${audioTarget.toFixed(3)}s`);
        _queuePreviewMediaSeek(seekedMedia, audio, audioTarget);
    }
    const previewBg = _resolvePreviewBackgroundPath(task);
    const vDur = _getVideoDuration(task);
    if (video && vDur > 0 && !previewBg.isMulti) {
        const bgDurScale = task && task.bgDurScale ? (task.bgDurScale / 100) : 1;
        const visualContentTarget = (task && task.audioPath) ? contentTarget : (contentTarget / Math.max(bgDurScale, 0.0001));
        const videoTarget = vDur > 0 ? (visualContentTarget % vDur) : visualContentTarget;
        console.log(`[Seek] Seeking BgVideo to ${videoTarget.toFixed(3)}s (vDur=${vDur.toFixed(3)}s)`);
        _queuePreviewMediaSeek(seekedMedia, video, videoTarget);
        const fadeVideo = _reelsState.previewFadeVideo;
        if (fadeVideo && task && task.audioPath) {
            const cfg = _getPreviewLoopFadeConfig();
            const fadeDur = Math.min(cfg.duration, Math.max(0.1, vDur * 0.45));
            const fadeTarget = (videoTarget + fadeDur) % vDur;
            _queuePreviewMediaSeek(seekedMedia, fadeVideo, fadeTarget);
        }
    } else if (task && previewBg.isMulti) {
        _syncPreviewMultiBackground(task, contentTarget);
        seekedMedia.push(document.getElementById('reels-preview-video'));
        seekedMedia.push(_reelsState.previewFadeVideo);
    }

    const contentVideoEl = document.getElementById('reels-preview-contentvideo');
    if (contentVideoEl && contentVideoEl.src) {
        console.log(`[Seek] ContentVideo src=${contentVideoEl.src ? 'yes' : 'no'}, readyState=${contentVideoEl.readyState}`);
        if (contentVideoEl.readyState >= 1) {
            const trimStart = parseFloat((task || {}).contentVideoTrimStart) || 0;
            const trimEnd = parseFloat((task || {}).contentVideoTrimEnd) || 0;
            const cvDuration = trimEnd > trimStart ? (trimEnd - trimStart) : (contentVideoEl.duration - trimStart);
            if (Number.isFinite(cvDuration) && cvDuration > 0) {
                const cvTarget = trimStart + (contentTarget % cvDuration);
                console.log(`[Seek] Seeking ContentVideo to ${cvTarget.toFixed(3)}s (trimStart=${trimStart.toFixed(3)}s, cvDuration=${cvDuration.toFixed(3)}s)`);
                _queuePreviewMediaSeek(seekedMedia, contentVideoEl, cvTarget);
            }
        }
    }

    // ── 同步 BGM seek ──
    const bgmAudio = _reelsState._bgmAudioEl;
    if (bgmAudio && bgmAudio.src && bgmAudio.duration > 0) {
        const bgmTarget = (_getTaskBgmStart(task) + contentTarget) % bgmAudio.duration;
        _queuePreviewMediaSeek(seekedMedia, bgmAudio, bgmTarget);
    }
    _refreshPreviewAfterSeek(target, duration, seekedMedia, seekToken, { deferFramePrime });
}

function _onVideoTimeUpdate() {
    const video = document.getElementById('reels-preview-video');
    if (!video) return;
    if (_isPreviewSeekLocked()) {
        const dur = _getPreviewDuration();
        const target = _reelsState.previewSeekLock.target;
        _updatePreviewTimeUI(target, dur);
        if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(target));
        return;
    }
    const task = _getSelectedTask();
    // 有配音时，以音频为主时钟，不用视频 timeupdate 驱动 UI
    if (task && task.audioPath) {
        _syncBackgroundVideoToMaster();
        return;
    }
    const cur = _getPreviewCurrentTime();
    const dur = _getPreviewDuration();
    _updatePreviewTimeUI(cur, dur);
    if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(cur));
}

function _onAudioTimeUpdate() {
    const audio = document.getElementById('reels-preview-audio');
    if (!audio) return;
    if (_isPreviewSeekLocked()) {
        const dur = _getPreviewDuration();
        const target = _reelsState.previewSeekLock.target;
        _updatePreviewTimeUI(target, dur);
        if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(target));
        return;
    }
    const cur = _getPreviewCurrentTime();
    const dur = _getPreviewDuration();
    _syncBackgroundVideoToMaster();
    _updatePreviewTimeUI(cur, dur);
    if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(cur));
}

function _onCvVideoTimeUpdate() {
    const cvVideo = document.getElementById('reels-preview-contentvideo');
    if (!cvVideo) return;
    if (_isPreviewSeekLocked()) {
        const dur = _getPreviewDuration();
        const target = _reelsState.previewSeekLock.target;
        _updatePreviewTimeUI(target, dur);
        if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(target));
        return;
    }
    const task = _getSelectedTask();
    const master = _getPreviewMasterElement();
    if (master === cvVideo) {
        if (task) {
            const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
            const trimEnd = parseFloat(task.contentVideoTrimEnd) || 0;
            const curTime = cvVideo.currentTime || 0;
            const loopEnabled = _isPreviewLoopEnabled();

            if (trimEnd > trimStart && curTime >= trimEnd) {
                if (loopEnabled) {
                    cvVideo.currentTime = trimStart;
                } else {
                    cvVideo.pause();
                    const btn = document.getElementById('reels-preview-play');
                    if (btn) btn.textContent = '▶️';
                }
            } else if (trimStart > 0 && curTime < trimStart) {
                cvVideo.currentTime = trimStart;
            }
        }
        _syncBackgroundVideoToMaster();
        const cur = _getPreviewCurrentTime();
        const dur = _getPreviewDuration();
        _updatePreviewTimeUI(cur, dur);
        if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(cur));
    }
}

function _onCvVideoLoaded() {
    _applyPreviewLoopMode();
    _applyPreviewAudioMix();
    _updateTimelineForTask(_getSelectedTask());
    _updatePreviewTimeUI(_getPreviewCurrentTime(), _getPreviewDuration());
    _onSeek({ absoluteTarget: _getPreviewCurrentTime() });
}

function _onVideoLoaded() {
    const video = document.getElementById('reels-preview-video');
    if (!video) return;
    const canvas = document.getElementById('reels-preview-canvas');
    if (canvas) {
        canvas.width = _reelsState.targetWidth || 1080;
        canvas.height = _reelsState.targetHeight || 1920;
    }

    _ensurePreviewFadeVideo(video);
    _applyPreviewLoopMode();
    _applyPreviewAudioMix();
    _updateTimelineForTask(_getSelectedTask());
    _updatePreviewTimeUI(_getPreviewCurrentTime(), _getPreviewDuration());
    _onSeek({ absoluteTarget: _getPreviewCurrentTime() });
}

function _onAudioLoaded() {
    _applyPreviewLoopMode();
    _applyPreviewAudioMix();
    _updateTimelineForTask(_getSelectedTask());
    _updatePreviewTimeUI(_getPreviewCurrentTime(), _getPreviewDuration());
    _onSeek({ absoluteTarget: _getPreviewCurrentTime() });
}

// ═══════════════════════════════════════════════════════
// Preset management (fully ported from AutoSub preset_manager.py)
// ═══════════════════════════════════════════════════════

function reelsOpenSubtitlePresetPicker(anchorEl) {
    if (!window._openStyledPresetPicker) return;
    const hiddenInput = document.getElementById('reels-preset-select');
    const currentVal = hiddenInput ? hiddenInput.value : '';
    window._openStyledPresetPicker(anchorEl, currentVal, (selectedVal) => {
        if (hiddenInput) {
            hiddenInput.value = selectedVal || '';
            const scope = typeof _getSubtitleStyleScope === 'function' ? _getSubtitleStyleScope() : 'task';
            const targets = scope === 'all' ? (_reelsState.tasks || []) : (scope === 'folder' ? _getCurrentReelsGroupTasks() : [_getSelectedTask()].filter(Boolean));
            targets.forEach(t => { t._subtitlePreset = ''; });
            if (typeof reelsLoadPresetQuick === 'function') reelsLoadPresetQuick();
            else if (typeof reelsLoadPreset === 'function') reelsLoadPreset();
        }
        const span = anchorEl.querySelector('span');
        if (span) span.textContent = selectedVal || '-- 改全部样式 --';
    });
}
window.reelsOpenSubtitlePresetPicker = reelsOpenSubtitlePresetPicker;

// 预设分组统一选择器：已有分组一键选择，也可输入新分组。
function reelsChoosePresetGroup(title, currentGroup = '我的预设', groups = []) {
    return new Promise(resolve => {
        const current = String(currentGroup || '我的预设').trim() || '我的预设';
        const options = [...new Set((groups || []).map(group => String(group || '').trim()).filter(Boolean))];
        if (!options.includes(current)) options.unshift(current);
        const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `<div style="width:min(420px,calc(100vw - 36px));box-sizing:border-box;padding:22px;border-radius:12px;background:var(--bg-primary,#1e1e2e);border:1px solid var(--border-color,#4b5563);box-shadow:0 14px 40px rgba(0,0,0,.45);color:var(--text-primary,#fff);"><div style="font-size:16px;font-weight:700;margin-bottom:14px;">${escape(title)}</div><label style="display:block;font-size:12px;color:var(--text-secondary,#aab);margin-bottom:5px;">已有分组</label><select class="rpg-select" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#28283b);color:var(--text-primary,#fff);font-size:14px;">${options.map(group => `<option value="${escape(group)}" ${group === current ? 'selected' : ''}>${escape(group)}</option>`).join('')}<option value="__new__">＋ 新建分组…</option></select><input class="rpg-new" type="text" placeholder="输入新分组名称" style="display:none;width:100%;box-sizing:border-box;margin-top:9px;padding:8px 10px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#28283b);color:var(--text-primary,#fff);font-size:14px;"><div style="display:flex;justify-content:flex-end;gap:9px;margin-top:18px;"><button class="rpg-cancel" style="padding:7px 16px;border-radius:6px;border:1px solid var(--border-color,#555);background:transparent;color:var(--text-secondary,#aab);cursor:pointer;">取消</button><button class="rpg-ok" style="padding:7px 16px;border:0;border-radius:6px;background:var(--accent-primary,#5b6abf);color:#fff;cursor:pointer;">确定</button></div></div>`;
        document.body.appendChild(overlay);
        const select = overlay.querySelector('.rpg-select');
        const input = overlay.querySelector('.rpg-new');
        const close = value => { overlay.remove(); resolve(value); };
        select.onchange = () => { input.style.display = select.value === '__new__' ? '' : 'none'; if (select.value === '__new__') input.focus(); };
        overlay.querySelector('.rpg-cancel').onclick = () => close(null);
        overlay.querySelector('.rpg-ok').onclick = () => close(select.value === '__new__' ? (input.value || '').trim() : select.value);
        overlay.onclick = event => { if (event.target === overlay) close(null); };
    });
}
window.reelsChoosePresetGroup = reelsChoosePresetGroup;

function reelsOpenSubtitlePresetLibrary() {
    if (!window.ReelsStyleEngine?.getPresetsByCategory) return;
    const hiddenInput = document.getElementById('reels-preset-select');
    const { categorized = [], presetsMap = {} } = window.ReelsStyleEngine.getPresetsByCategory();
    const myPresetNames = categorized.find(group => group.category === '💾 我的预设')?.names || [];
    const modal = document.createElement('div');
    modal.className = 'reels-subtitle-preset-library';
    const groups = categorized.map(g => `<button data-group="${String(g.category).replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">${String(g.category).replace(/</g,'&lt;')} <small>${g.names.length}</small></button>`).join('');
    const previewStyles = [];
    const cards = categorized.flatMap(g => g.names.map(name => {
        const style = presetsMap[name] || {};
        const custom = g.category.startsWith('💾');
        const title = String(name).replace(/</g,'&lt;');
        const animated = (style.anim_in_type && style.anim_in_type !== 'none') || style.box_wipe_enabled || style.dynamic_box || style.karaoke_highlight || style.word_pop;
        const previewIndex = previewStyles.push(style) - 1;
        // 画布显示时缩小，但渲染仍使用成片的 1080×1920 坐标系，保证预设
        // 内保存的像素字号、X/Y 坐标与最终导出完全一致。
        return `<article class="rsp-card" data-animated="${animated ? 'true' : 'false'}" data-group="${String(g.category).replace(/&/g,'&amp;').replace(/"/g,'&quot;')}" data-name="${String(name).replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"><canvas class="rsp-preview-canvas" width="360" height="640" data-preview-index="${previewIndex}" aria-label="${title} 的字幕效果预览"></canvas><div class="rsp-name">${title}</div><div class="rsp-group">${String(g.category).replace(/</g,'&lt;')}${animated ? ' · 悬浮播放' : ''}</div><button class="rsp-use">选用</button>${custom ? '<button class="rsp-move-group">分组</button><button class="rsp-delete">删除</button>' : ''}</article>`;
    })).join('');
    modal.innerHTML = `<div class="rsp-shell"><header><h2>动态字幕预设库</h2><div style="display:flex;align-items:center;gap:10px;"><button class="rsp-clear-mine" ${myPresetNames.length ? '' : 'disabled'} title="只删除“我的预设”分组，不影响内置预设、模板同步或覆层预设">清空我的预设</button><button class="rsp-close">✕</button></div></header><div class="rsp-main"><aside><button data-group="all" class="active">全部预设</button>${groups}</aside><section><div class="rsp-grid">${cards || '<p>暂无预设</p>'}</div></section></div></div>`;
    document.body.appendChild(modal);
    // 卡片预览与导出/编辑面板使用同一个 Canvas 渲染器。悬浮时从 0 秒
    // 重新播放，因而展示的是每套预设本身的入场、逐词、卡拉 OK 等真实效果。
    // 静态卡片只看第一句最终版式；悬浮时按连续多条 SRT 播放，方便判断
    // 逐词、入场、退场以及相邻字幕切换的真实效果。
    const previewSegments = [
        { start: 0, end: 3, text: '示例 字幕 动画 预览', words: [
            { word: '示例', start: 0, end: 0.75 }, { word: '字幕', start: 0.75, end: 1.5 },
            { word: '动画', start: 1.5, end: 2.25 }, { word: '预览', start: 2.25, end: 3 },
        ] },
        { start: 3, end: 6, text: '悬浮 即可 预览 效果', words: [
            { word: '悬浮', start: 3, end: 3.75 }, { word: '即可', start: 3.75, end: 4.5 },
            { word: '预览', start: 4.5, end: 5.25 }, { word: '效果', start: 5.25, end: 6 },
        ] },
        { start: 6, end: 9, text: '最终 位置 保持 不变', words: [
            { word: '最终', start: 6, end: 6.75 }, { word: '位置', start: 6.75, end: 7.5 },
            { word: '保持', start: 7.5, end: 8.25 }, { word: '不变', start: 8.25, end: 9 },
        ] },
    ];
    const previewSegment = previewSegments[0];
    const previewDuration = previewSegments[previewSegments.length - 1].end;
    const activePreviewFrames = new Set();
    const staticPreviewTime = previewSegment.end - 0.05;
    const stopPreviewFrames = () => {
        activePreviewFrames.forEach(id => cancelAnimationFrame(id));
        activePreviewFrames.clear();
    };
    modal.querySelectorAll('.rsp-preview-canvas').forEach(canvas => {
        const style = previewStyles[Number(canvas.dataset.previewIndex)] || {};
        if (!window.ReelsCanvasRenderer) return;
        const renderer = new window.ReelsCanvasRenderer(canvas);
        // 全页打字机、滚动等字幕预设会读取整条 SRT 上下文；没有这一步会
        // 只剩光标或空画布，而不是最终成片中的字幕。
        renderer.setContextSegments(previewSegments);
        const ctx = canvas.getContext('2d');
        const outputWidth = 1080;
        const outputHeight = 1920;
        const renderScale = canvas.width / outputWidth;
        // 卡片静止时必须是“动画完成后的成片样子”，不能停在淡入/淡出的
        // 半透明中间帧。悬浮时才使用原始动画配置与真实 SRT 时间轴。
        const isBoxWipeCard = Boolean(style.box_wipe_enabled || style.anim_in_type === 'box_wipe');
        const finalStyle = {
            ...style,
            anim_in_type: isBoxWipeCard ? 'box_wipe' : 'none',
            anim_out_type: 'none',
            dynamic_box: false,
            karaoke_highlight: false,
            word_pop: false,
            fullpage_typewriter: false,
        };
        const cardStaticTime = isBoxWipeCard
            ? (previewSegment.start + (previewSegment.end - previewSegment.start) * 0.65)
            : staticPreviewTime;
        const draw = (time, animated = false) => {
            const activeSegment = animated
                ? (previewSegments.find(segment => time >= segment.start && time <= segment.end) || previewSegment)
                : previewSegment;
            ctx.save();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#11111f';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.restore();
            ctx.save();
            ctx.scale(renderScale, renderScale);
            renderer.renderSubtitle(animated ? style : finalStyle, activeSegment, time, outputWidth, outputHeight);
            ctx.restore();
        };
        draw(cardStaticTime, false);
        const card = canvas.closest('.rsp-card');
        let frameId = null;
        card.addEventListener('mouseenter', () => {
            if (frameId !== null) return;
            const beganAt = performance.now();
            const play = (now) => {
                const seconds = ((now - beganAt) / 1000) % previewDuration;
                draw(seconds, true);
                frameId = requestAnimationFrame(play);
                activePreviewFrames.add(frameId);
            };
            frameId = requestAnimationFrame(play);
            activePreviewFrames.add(frameId);
        });
        card.addEventListener('mouseleave', () => {
            if (frameId !== null) cancelAnimationFrame(frameId);
            activePreviewFrames.delete(frameId);
            frameId = null;
            draw(cardStaticTime, false);
        });
    });
    modal.querySelectorAll('aside button').forEach(btn => btn.onclick = () => { modal.querySelectorAll('aside button').forEach(b => b.classList.remove('active')); btn.classList.add('active'); const group = btn.dataset.group; modal.querySelectorAll('.rsp-card').forEach(card => card.style.display = group === 'all' || card.dataset.group === group ? '' : 'none'); });
    modal.querySelector('.rsp-close').onclick = () => { stopPreviewFrames(); modal.remove(); };
    modal.querySelector('.rsp-clear-mine').onclick = () => {
        if (!myPresetNames.length) return;
        if (!confirm(`确定清空“我的预设”中的 ${myPresetNames.length} 个动态字幕预设吗？\n\n内置预设、模板同步分组和覆层预设不会删除。`)) return;
        myPresetNames.forEach(name => window.ReelsStyleEngine.deleteSubtitlePreset(name));
        stopPreviewFrames();
        modal.remove();
        reelsOpenSubtitlePresetLibrary();
        if (typeof _reelsRefreshPresetList === 'function') _reelsRefreshPresetList();
        if (typeof _renderBatchTable === 'function') _renderBatchTable();
    };
    modal.querySelectorAll('.rsp-use').forEach(btn => btn.onclick = event => {
        const selectedVal = event.currentTarget.closest('.rsp-card').dataset.name;
        if (hiddenInput) {
            hiddenInput.value = selectedVal || '';

            // 从字幕面板选择预设应当“落地”为当前样式，而不是给任务留下
            // 高优先级的 _subtitlePreset 引用。后者会覆盖随后在面板中做的
            // 颜色/色块调整，造成必须手动再改一次才显示的假象。
            const scope = typeof _getSubtitleStyleScope === 'function' ? _getSubtitleStyleScope() : 'task';
            const targets = scope === 'all'
                ? (_reelsState.tasks || [])
                : (scope === 'folder' ? _getCurrentReelsGroupTasks() : [_getSelectedTask()].filter(Boolean));
            targets.forEach(t => { t._subtitlePreset = ''; });

            if (typeof reelsLoadPresetQuick === 'function') {
                reelsLoadPresetQuick();
            } else if (typeof reelsLoadPreset === 'function') {
                reelsLoadPreset();
            }
        }
        const span = document.querySelector('#reels-preset-select-trigger span');
        if (span) {
            span.textContent = selectedVal || '-- 改全部样式 --';
        }
        stopPreviewFrames();
        modal.remove();
    });
    modal.querySelectorAll('.rsp-delete').forEach(btn => btn.onclick = event => { const card = event.currentTarget.closest('.rsp-card'); const name = card.dataset.name; if (!confirm(`删除动态字幕预设「${name}」？`)) return; window.ReelsStyleEngine.deleteSubtitlePreset(name); card.remove(); });
    modal.querySelectorAll('.rsp-move-group').forEach(btn => btn.onclick = async event => {
        const card = event.currentTarget.closest('.rsp-card');
        const currentGroup = String(card.dataset.group || '').replace(/^💾\s*/, '') || '我的预设';
        const savedGroups = categorized.filter(group => group.category.startsWith('💾')).map(group => group.category.replace(/^💾\s*/, ''));
        const nextGroup = await reelsChoosePresetGroup('移动动态字幕预设分组', currentGroup, savedGroups);
        if (!nextGroup || !String(nextGroup).trim()) return;
        window.ReelsStyleEngine.setSubtitlePresetGroup(card.dataset.name, String(nextGroup).trim());
        stopPreviewFrames();
        modal.remove();
        reelsOpenSubtitlePresetLibrary();
    });
}
window.reelsOpenSubtitlePresetLibrary = reelsOpenSubtitlePresetLibrary;

function _reelsRefreshPresetList() {
    const hidden = document.getElementById('reels-preset-select');
    if (!hidden || !window.ReelsStyleEngine) return;
    _reelsRefreshDefaultPresetIndicator();
}

function _reelsRefreshDefaultPresetIndicator() {
    const indicator = document.getElementById('reels-default-preset-indicator');
    if (!indicator) return;
    const defaultName = localStorage.getItem(REELS_DEFAULT_PRESET_KEY) || '';
    indicator.textContent = defaultName ? `默认模板: ${defaultName}` : '默认模板: 未设置';
}

function _reelsApplyDefaultPreset() {
    if (!window.ReelsStyleEngine) return;
    const defaultName = localStorage.getItem(REELS_DEFAULT_PRESET_KEY) || '';
    if (!defaultName) {
        _reelsRefreshDefaultPresetIndicator();
        return;
    }
    const data = ReelsStyleEngine.loadSubtitlePresets();
    if (!data.presets || !data.presets[defaultName]) {
        localStorage.removeItem(REELS_DEFAULT_PRESET_KEY);
        _reelsRefreshPresetList();
        return;
    }

    const style = ReelsStyleEngine.applySubtitlePreset(defaultName);
    _reelsState.style = Object.assign({}, _reelsState.style || {}, style);
    _writeStyleToUI(style);
    const select = document.getElementById('reels-preset-select');
    if (select) select.value = defaultName;
    _reelsRefreshDefaultPresetIndicator();
}

function reelsSetDefaultPreset() {
    const select = document.getElementById('reels-preset-select');
    if (!select) return;
    const name = select.value;
    if (!name) {
        alert('请先选择一个预设');
        return;
    }
    localStorage.setItem(REELS_DEFAULT_PRESET_KEY, name);
    _reelsRefreshPresetList();
    alert(`已设为默认模板：${name}`);
}

/**
 * 自定义输入弹窗（替代 Electron 不支持的 prompt()）
 */
function _showInputDialog(title, placeholder, defaultValue = '') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-primary,#1e1e2e);border:1px solid var(--border-color,#444);border-radius:12px;padding:24px;min-width:340px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
        box.innerHTML = `
            <div style="font-size:15px;font-weight:600;margin-bottom:14px;color:var(--text-primary,#fff);">${title}</div>
            <input type="text" id="_input_dialog_val" value="${String(defaultValue).replace(/"/g, '&quot;')}" placeholder="${placeholder || ''}"
                style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:14px;outline:none;">
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
                <button id="_input_dialog_cancel" style="padding:6px 18px;border-radius:6px;border:1px solid var(--border-color,#555);background:transparent;color:var(--text-secondary,#aaa);cursor:pointer;font-size:13px;">取消</button>
                <button id="_input_dialog_ok" style="padding:6px 18px;border-radius:6px;border:none;background:var(--accent-primary,#5b6abf);color:#fff;cursor:pointer;font-size:13px;">确定</button>
            </div>`;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const input = box.querySelector('#_input_dialog_val');
        const okBtn = box.querySelector('#_input_dialog_ok');
        const cancelBtn = box.querySelector('#_input_dialog_cancel');

        // 防止外层事件监听器抢焦点
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
        box.addEventListener('mousedown', (e) => e.stopPropagation());

        const close = (val) => {
            if (overlay.parentNode) document.body.removeChild(overlay);
            resolve(val);
        };

        okBtn.onclick = () => close(input.value.trim() || null);
        cancelBtn.onclick = () => close(null);
        overlay.onclick = (e) => { if (e.target === overlay) close(null); };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') close(input.value.trim() || null);
            if (e.key === 'Escape') close(null);
        });
        // 多次尝试 focus 确保 Electron 渲染完成后能获得焦点
        setTimeout(() => input.focus(), 50);
        setTimeout(() => { if (document.activeElement !== input) input.focus(); }, 150);
    });
}
window.reelsShowInputDialog = _showInputDialog;

window.showNamingSettingsDialog = function(mode) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
        
        const isDate = mode === 'date-auto';
        const title = isDate ? '按日期自动排序命名设置' : '纯序号命名设置';
        
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowY = tomorrow.getFullYear();
        const tomorrowM = String(tomorrow.getMonth() + 1).padStart(2, '0');
        const tomorrowD = String(tomorrow.getDate()).padStart(2, '0');
        const defaultDate = localStorage.getItem('reels_naming_start_date') || `${tomorrowY}-${tomorrowM}-${tomorrowD}`;
        const defaultVids = localStorage.getItem('reels_naming_vids_per_day') || '3';
        const defaultPrefix = localStorage.getItem('reels_naming_prefix') || '';
        const defaultSuffix = localStorage.getItem('reels_naming_suffix') || '';
        
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-primary,#1e1e2e);border:1px solid var(--border-color,#444);border-radius:12px;padding:24px;width:380px;box-shadow:0 8px 32px rgba(0,0,0,0.5);color:var(--text-primary,#fff);font-family:system-ui, sans-serif;';
        
        let fieldsHtml = '';
        if (isDate) {
            fieldsHtml += `
                <div style="margin-bottom:12px;">
                    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">起始日期:</label>
                    <input type="date" id="_ns_start_date" value="${defaultDate}"
                        style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:13px;outline:none;">
                </div>
                <div style="margin-bottom:12px;">
                    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">每天视频数量:</label>
                    <select id="_ns_vids_per_day"
                        style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:13px;outline:none;cursor:pointer;">
                        <option value="1" ${defaultVids === '1' ? 'selected' : ''}>1</option>
                        <option value="2" ${defaultVids === '2' ? 'selected' : ''}>2</option>
                        <option value="3" ${defaultVids === '3' ? 'selected' : ''}>3</option>
                        <option value="4" ${defaultVids === '4' ? 'selected' : ''}>4</option>
                        <option value="5" ${defaultVids === '5' ? 'selected' : ''}>5</option>
                        <option value="6" ${defaultVids === '6' ? 'selected' : ''}>6</option>
                    </select>
                </div>
            `;
        }
        
        fieldsHtml += `
            <div style="margin-bottom:12px;">
                <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">文件名自定义前缀 (可选):</label>
                <input type="text" id="_ns_prefix" value="${defaultPrefix}" placeholder="例如: 爆款-"
                    style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:13px;outline:none;">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">文件名自定义后缀 (可选):</label>
                <input type="text" id="_ns_suffix" value="${defaultSuffix}" placeholder="例如: -成品"
                    style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:13px;outline:none;">
            </div>
        `;
        
        box.innerHTML = `
            <div style="font-size:15px;font-weight:600;margin-bottom:16px;color:var(--text-primary,#fff);">${title}</div>
            ${fieldsHtml}
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
                <button id="_ns_cancel" style="padding:6px 18px;border-radius:6px;border:1px solid var(--border-color,#555);background:transparent;color:var(--text-secondary,#aaa);cursor:pointer;font-size:13px;">取消</button>
                <button id="_ns_ok" style="padding:6px 18px;border-radius:6px;border:none;background:var(--accent-primary,#5b6abf);color:#fff;cursor:pointer;font-size:13px;font-weight:bold;">确定</button>
            </div>
        `;
        
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        
        box.addEventListener('mousedown', (e) => e.stopPropagation());
        box.addEventListener('click', (e) => e.stopPropagation());
        
        const close = (success) => {
            if (overlay.parentNode) document.body.removeChild(overlay);
            resolve(success);
        };
        
        box.querySelector('#_ns_cancel').onclick = () => close(false);
        box.querySelector('#_ns_ok').onclick = () => {
            if (isDate) {
                const sDate = box.querySelector('#_ns_start_date').value;
                const vDay = box.querySelector('#_ns_vids_per_day').value;
                localStorage.setItem('reels_naming_start_date', sDate);
                localStorage.setItem('reels_naming_vids_per_day', vDay);
            }
            const pfx = box.querySelector('#_ns_prefix').value;
            const sfx = box.querySelector('#_ns_suffix').value;
            localStorage.setItem('reels_naming_prefix', pfx);
            localStorage.setItem('reels_naming_suffix', sfx);
            close(true);
        };
        overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    });
};

async function reelsSavePreset() {
    console.log('[预设] 保存按钮被点击');
    try {
        const name = await _showInputDialog('保存字幕预设', '请输入预设名称');
        console.log('[预设] 用户输入名称:', name);
        if (!name) return;
        const style = _readStyleFromUI();
        if (window.ReelsStyleEngine) {
            const allPresets = ReelsStyleEngine.loadSubtitlePresets().presets || {};
            if (allPresets[name]) {
                const ok = confirm(`预设 "${name}" 已存在，是否覆盖？`);
                if (!ok) return;
            }
            const group = (await _showInputDialog('字幕预设分组', '输入分组名称（留空为“我的预设”）')) || '我的预设';
            const result = ReelsStyleEngine.saveNamedSubtitlePreset(name, style, group);
            if (result) {
                _reelsRefreshPresetList();
                const select = document.getElementById('reels-preset-select');
                if (select) select.value = name;
                const triggerLabel = document.querySelector('#reels-preset-select-trigger span');
                if (triggerLabel) triggerLabel.textContent = name;
                showToast(`字幕预设已保存：${name}`, 'success', 3000);
                console.log(`[预设] 保存成功: "${name}", keys: ${Object.keys(style).length}`);
            } else {
                alert('字幕预设保存失败：' + (ReelsStyleEngine.getLastPresetSaveError?.() || '无法写入预设库，请检查保存目录是否可写。'));
            }
        } else {
            console.error('[预设] ReelsStyleEngine 未加载！');
            alert('字幕模板引擎未加载，请重新打开软件后再试。');
        }
    } catch (e) {
        console.error('[预设] 保存出错:', e);
        alert(`字幕预设保存失败：${e.message || String(e)}`);
    }
}

function reelsSaveFolderQueuePresets() {
    if (!window.ReelsStyleEngine) {
        alert('字幕模板引擎未加载');
        return;
    }
    _persistSubtitleStyleByScope(_readStyleFromUI());
    const queues = new Map();
    for (const task of _reelsState.tasks) {
        if (!task?._folderQueueId) continue;
        if (!queues.has(task._folderQueueId)) queues.set(task._folderQueueId, []);
        queues.get(task._folderQueueId).push(task);
    }
    if (queues.size === 0) {
        alert('当前没有文件夹队列');
        return;
    }

    let saved = 0;
    let failed = 0;
    for (const queueTasks of queues.values()) {
        const firstTask = queueTasks[0];
        const queueName = String(firstTask._folderQueueName || '文件夹队列').trim();
        const presetName = `队列_${queueName}`;
        const style = _cloneSubtitleStyle(firstTask.subtitleStyle)
            || _cloneSubtitleStyle(_reelsState.globalSubtitleStyle)
            || _readStyleFromUI();
        if (ReelsStyleEngine.saveNamedSubtitlePreset(presetName, style)) saved++;
        else failed++;
    }
    _reelsRefreshPresetList();
    showToast(
        `已保存 ${saved} 个队列字幕模板${failed ? `，${failed} 个保存失败` : ''}`,
        failed ? 'warning' : 'success',
        5000
    );
}

function reelsLoadPreset(silent = false) {
    const select = document.getElementById('reels-preset-select');
    if (!select) return;
    const name = select.value;
    if (!name) { if (!silent) alert('请先选择一个预设'); return; }
    if (window.ReelsStyleEngine) {
        const style = _getNamedSubtitlePresetStyle(name);
        if (!style) {
            select.value = '';
            if (!silent) alert(`预设不存在或已删除：${name}`);
            return;
        }
        _reelsState.style = Object.assign({}, _reelsState.style || {}, style);
        _writeStyleToUI(style);
        // 选择预设后立即回写目标任务；不能依赖后续手动改控件才能生效。
        _persistSubtitleStyleByScope(_readStyleFromUI());
        reelsUpdatePreview();
    }
}

function reelsLoadPresetQuick() {
    reelsLoadPreset(true);
}

function reelsDeletePreset() {
    const select = document.getElementById('reels-preset-select');
    if (!select) return;
    const name = select.value;
    if (!name) { alert('请先选择一个预设'); return; }
    if (confirm(`确定删除预设 "${name}"？`)) {
        if (window.ReelsStyleEngine) {
            ReelsStyleEngine.deleteSubtitlePreset(name);
            const defaultName = localStorage.getItem(REELS_DEFAULT_PRESET_KEY) || '';
            if (defaultName === name) {
                localStorage.removeItem(REELS_DEFAULT_PRESET_KEY);
            }
            _reelsRefreshPresetList();
        }
    }
}

function reelsExportPresets() {
    if (!window.ReelsStyleEngine) return;
    const json = ReelsStyleEngine.exportSubtitlePresets();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'subtitle_presets.json';
    a.click();
    URL.revokeObjectURL(url);
}

function reelsImportPresets() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.multiple = true;
    input.onchange = async (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0 || !window.ReelsStyleEngine) return;

        const bundles = [];
        const unreadable = [];
        for (const file of files) {
            try {
                bundles.push({ source: file.name, data: JSON.parse(await file.text()) });
            } catch (err) {
                unreadable.push(file.name);
                console.error(`[预设] 无法读取 ${file.name}:`, err);
            }
        }

        const existingPresets = ReelsStyleEngine.loadSubtitlePresets().presets || {};
        const prepared = ReelsStyleEngine.prepareSubtitlePresetBatchImport(bundles, existingPresets);
        let overwriteConflicts = false;
        if (prepared.conflicts.length > 0) {
            overwriteConflicts = confirm(
                `发现 ${prepared.conflicts.length} 个同名但内容不同的预设：\n`
                + `${prepared.conflicts.join(', ')}\n\n是否覆盖？（取消将保留现有预设）`
            );
        }

        const result = ReelsStyleEngine.importSubtitlePresets(
            JSON.stringify(prepared.payload),
            overwriteConflicts
        );
        _reelsRefreshPresetList();

        const duplicateCount = prepared.duplicates.length + (result.duplicates?.length || 0);
        const invalidItems = [...unreadable, ...prepared.invalid];
        const skippedCount = result.skipped.length + prepared.batchConflicts.length;
        const details = [];
        if (duplicateCount > 0) details.push(`自动排重 ${duplicateCount} 个`);
        if (skippedCount > 0) details.push(`跳过 ${skippedCount} 个`);
        if (prepared.batchConflicts.length > 0) details.push(`批内同名异内容 ${prepared.batchConflicts.length} 个（保留先选文件）`);
        if (invalidItems.length > 0) details.push(`无效文件/条目 ${invalidItems.length} 个`);
        alert(
            `✅ 批量导入完成（已选择 ${files.length} 个文件）\n`
            + `新增 ${result.added.length} 个，覆盖 ${result.conflicts.length} 个`
            + `${details.length ? `，${details.join('，')}` : ''}`
            + `${invalidItems.length ? `\n\n未导入：${invalidItems.slice(0, 8).join('、')}` : ''}`
        );
    };
    input.click();
}

// ═══════════════════════════════════════════════════════
// Export (FFmpeg via IPC)
// ═══════════════════════════════════════════════════════

function _reelsUpdateLastOutputUI(outputPath) {
    const outEl = document.getElementById('reels-export-last-output');
    const openBtn = document.getElementById('reels-open-last-output-btn');
    if (outEl) outEl.value = outputPath || '';
    if (openBtn) openBtn.disabled = !outputPath;
}

function _reelsUpdateLastErrorUI(message) {
    const errEl = document.getElementById('reels-export-last-error');
    if (!errEl) return;
    const text = (message && String(message).trim()) ? String(message).trim() : '无';
    errEl.textContent = text;
    errEl.style.color = text === '无' ? 'var(--text-secondary)' : '#ff8a8a';
}

function _formatReelsCrashDiagnostic(report = {}) {
    const reasonNames = {
        'oom': '内存不足',
        'crashed': '渲染进程崩溃',
        'killed': '进程被系统终止',
        'abnormal-exit': '进程异常退出',
        'launch-failed': '进程启动失败',
        'integrity-failure': '进程完整性检查失败',
    };
    const rawReason = String(report.reason || 'unknown');
    const localTime = report.timestamp
        ? new Date(report.timestamp).toLocaleString('zh-CN', { hour12: false })
        : '未知';
    return [
        'VideoKit 崩溃诊断',
        `时间：${localTime}`,
        `版本：${report.appVersion || '未知'}`,
        `进程：${report.process || 'renderer'}`,
        `原因：${reasonNames[rawReason] || rawReason} (${rawReason})`,
        `退出码：${report.exitCode ?? '未知'}`,
        `系统：${report.platform || '未知'} ${report.arch || ''}`.trim(),
        `Electron：${report.electron || '未知'}`,
        `Chrome：${report.chrome || '未知'}`,
        report.diagnosticFile ? `完整日志：${report.diagnosticFile}` : '',
    ].filter(Boolean).join('\n');
}

function _showReelsCrashDiagnostic(report, options = {}) {
    if (!report || !report.timestamp) return;
    const panel = document.getElementById('reels-crash-diagnostic');
    const textEl = document.getElementById('reels-crash-diagnostic-text');
    if (!panel || !textEl) return;
    panel.hidden = false;
    panel.dataset.timestamp = report.timestamp;
    textEl.textContent = _formatReelsCrashDiagnostic(report);
    const exportBar = document.querySelector('.nle-export-bar');
    if (exportBar) exportBar.open = true;
    if (!options.restored) {
        _reelsUpdateLastErrorUI(`后台渲染进程异常退出：${report.reason || 'unknown'}（已自动尝试恢复）`);
        _reelsAppendExportLogUI(textEl.textContent, 'error');
    }
}

async function _copyReelsCrashDiagnostic(button) {
    const text = (document.getElementById('reels-crash-diagnostic-text') || {}).textContent || '';
    if (!text) return;
    try {
        if (window.electronAPI && window.electronAPI.writeClipboardText) {
            window.electronAPI.writeClipboardText(text);
        } else {
            await navigator.clipboard.writeText(text);
        }
        button.textContent = '已复制，可直接粘贴反馈';
        setTimeout(() => { button.textContent = '一键复制诊断'; }, 1800);
    } catch (_) {
        button.textContent = '复制失败，请手动选择';
        setTimeout(() => { button.textContent = '一键复制诊断'; }, 1800);
    }
}

function _initReelsCrashDiagnostics() {
    const panel = document.getElementById('reels-crash-diagnostic');
    const copyBtn = document.getElementById('reels-crash-diagnostic-copy');
    const dismissBtn = document.getElementById('reels-crash-diagnostic-dismiss');
    if (!panel || panel.dataset.bound) return;
    panel.dataset.bound = '1';
    if (copyBtn) copyBtn.addEventListener('click', () => _copyReelsCrashDiagnostic(copyBtn));
    if (dismissBtn) dismissBtn.addEventListener('click', () => {
        if (panel.dataset.timestamp) localStorage.setItem('reels-dismissed-crash-timestamp', panel.dataset.timestamp);
        panel.hidden = true;
    });
    const api = window.electronAPI;
    if (!api) return;
    if (api.onReelsCrashDiagnostic) {
        api.onReelsCrashDiagnostic(report => {
            if (!report || report.reason === 'clean-exit' || report.reason === 'killed') return;
            _showReelsCrashDiagnostic(report);
        });
    }
    if (api.getLatestCrashDiagnostic) {
        api.getLatestCrashDiagnostic().then(report => {
            if (!report || !report.timestamp) return;
            const reason = String(report.reason || '');
            if (reason === 'clean-exit' || reason === 'killed') return;
            if (report.timestamp === localStorage.getItem('reels-dismissed-crash-timestamp')) return;
            _showReelsCrashDiagnostic(report, { restored: true });
        }).catch(() => {});
    }
}

function _reelsResetExportLogUI() {
    const logEl = document.getElementById('reels-export-log');
    if (logEl) logEl.textContent = '';
    const detailsEl = document.getElementById('reels-export-log-details');
    if (detailsEl) detailsEl.open = false;
    const copyBtn = document.getElementById('reels-export-log-copy');
    if (copyBtn && !copyBtn.dataset.bound) {
        copyBtn.dataset.bound = '1';
        copyBtn.addEventListener('click', async () => {
            const text = (document.getElementById('reels-export-log') || {}).textContent || '';
            try {
                await navigator.clipboard.writeText(text);
                copyBtn.textContent = '已复制';
                setTimeout(() => { copyBtn.textContent = '复制日志'; }, 1200);
            } catch (_) {
                // Clipboard can be unavailable in older Electron builds.
                const range = document.createRange();
                const log = document.getElementById('reels-export-log');
                if (!log) return;
                range.selectNodeContents(log);
                const selection = window.getSelection();
                selection.removeAllRanges(); selection.addRange(range);
                document.execCommand('copy'); selection.removeAllRanges();
            }
        });
    }
}

function _reelsAppendExportLogUI(message, level = 'info') {
    const logEl = document.getElementById('reels-export-log');
    if (!logEl || !message) return;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const tag = level === 'error' ? '错误' : (level === 'warn' ? '提示' : '信息');
    const lines = `${logEl.textContent || ''}\n[${time}] ${tag}：${String(message).trim()}`
        .trim().split('\n').slice(-250);
    logEl.textContent = lines.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
    if (level === 'error') {
        const detailsEl = document.getElementById('reels-export-log-details');
        if (detailsEl) detailsEl.open = true;
    }
}

function _reelsUpdateExportProgressUI(done, total) {
    const progressInner = document.getElementById('reels-export-progress-inner');
    const progressText = document.getElementById('reels-export-progress-text');
    const safeTotal = Math.max(0, total || 0);
    const safeDone = Math.max(0, Math.min(done || 0, safeTotal));
    const pct = safeTotal > 0 ? Math.round((safeDone / safeTotal) * 100) : 0;
    if (progressInner) progressInner.style.width = `${pct}%`;
    if (progressText) progressText.textContent = `${pct}% (${safeDone}/${safeTotal})`;
}

function _reelsInitJobProgressUI(jobs) {
    const list = document.getElementById('reels-export-job-progress-list');
    if (!list) return;
    list.replaceChildren();
    if (!Array.isArray(jobs) || jobs.length === 0) {
        list.style.display = 'none';
        return;
    }

    const heading = document.createElement('div');
    heading.textContent = `任务进度（${jobs.length}）`;
    heading.style.cssText = 'font-size:11px;color:var(--text-secondary);margin:0 2px 5px;';
    list.appendChild(heading);

    jobs.forEach((job, index) => {
        const row = document.createElement('div');
        row.dataset.jobIndex = String(index);
        row.dataset.jobState = 'pending';
        row.dataset.jobProgress = '0';
        row.style.cssText = 'display:grid;grid-template-columns:minmax(130px,1fr) minmax(80px,1.15fr) 72px 78px 38px;gap:7px;align-items:center;padding:4px 3px;border-top:1px solid rgba(255,255,255,.055);font-size:10px;';

        const name = document.createElement('span');
        const presetLabel = job && job.presetName ? ` [${job.presetName}]` : '';
        name.textContent = `${index + 1}. ${(job && job.task && job.task.fileName) || '未命名任务'}${presetLabel}`;
        name.title = name.textContent;
        name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary);';

        const track = document.createElement('span');
        track.style.cssText = 'height:5px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden;';
        const bar = document.createElement('span');
        bar.dataset.role = 'bar';
        bar.style.cssText = 'display:block;width:0;height:100%;border-radius:inherit;background:#6b7280;transition:width .16s linear,background-color .16s;';
        track.appendChild(bar);

        const stage = document.createElement('span');
        stage.dataset.role = 'stage';
        stage.textContent = '等待中';
        stage.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);';

        const speed = document.createElement('span');
        speed.dataset.role = 'speed';
        speed.textContent = '检测中';
        speed.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;color:var(--text-secondary);';

        const percent = document.createElement('span');
        percent.dataset.role = 'percent';
        percent.textContent = '0%';
        percent.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums;color:var(--text-secondary);';

        row.append(name, track, stage, speed, percent);
        list.appendChild(row);

        let capabilityTask = job && job.task;
        if (capabilityTask && job.presetName && typeof _cloneTaskWithPreset === 'function') {
            capabilityTask = _cloneTaskWithPreset(capabilityTask, job.presetName);
        }
        const exportEngine = (document.getElementById('reels-export-engine') || {}).value || 'precise';
        const fastEngineEnabled = exportEngine === 'pipeline' || exportEngine === 'hardware';
        const fastAlphaEnabled = fastEngineEnabled
            || (document.getElementById('reels-fast-alpha-mode') || {}).checked === true;
        const capability = _getReelsFastExportCapability(capabilityTask);
        const display = _describeReelsFastCapability(capability, fastAlphaEnabled, fastEngineEnabled);
        _reelsUpdateJobFastCapabilityUI(index, display.kind, display.reason);
    });
    list.style.display = 'block';
    list.scrollTop = 0;
}

function _reelsUpdateJobFastCapabilityUI(jobIndex, kind, reason = '') {
    const list = document.getElementById('reels-export-job-progress-list');
    if (!list) return;
    const safeIndex = Math.max(0, Math.floor(Number(jobIndex) || 0));
    const speedEl = list.querySelector(`[data-job-index="${safeIndex}"] [data-role="speed"]`);
    if (!speedEl) return;
    const states = {
        full: { text: '⚡ 极速链路', color: '#43c977' },
        available: { text: '支持极速', color: '#43c977' },
        partial: { text: '部分加速', color: '#d6a84b' },
        unsupported: { text: '不支持极速', color: '#d6a84b' },
        none: { text: '不适用', color: 'var(--text-secondary)' },
    };
    const view = states[kind] || { text: '检测中', color: 'var(--text-secondary)' };
    speedEl.textContent = view.text;
    speedEl.style.color = view.color;
    speedEl.title = reason || view.text;
}

function _reelsUpdateJobProgressUI(jobIndex, pct, stage, state = 'running') {
    const list = document.getElementById('reels-export-job-progress-list');
    if (!list) return;
    const safeIndex = Math.max(0, Math.floor(Number(jobIndex) || 0));
    const row = list.querySelector(`[data-job-index="${safeIndex}"]`);
    if (!row) return;
    if (state === 'running' && ['success', 'failed', 'canceled'].includes(row.dataset.jobState)) return;

    const reported = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const normalized = Math.max(Number(row.dataset.jobProgress) || 0, reported);
    const colors = {
        pending: '#6b7280',
        running: '#4da3ff',
        success: '#43c977',
        failed: '#ff6b6b',
        canceled: '#d6a84b',
    };
    row.dataset.jobState = state;
    row.dataset.jobProgress = String(normalized);
    const bar = row.querySelector('[data-role="bar"]');
    const stageEl = row.querySelector('[data-role="stage"]');
    const percentEl = row.querySelector('[data-role="percent"]');
    if (bar) {
        bar.style.width = `${normalized}%`;
        bar.style.backgroundColor = colors[state] || colors.running;
    }
    if (stageEl) {
        stageEl.textContent = stage || (state === 'pending' ? '等待中' : '导出中');
        stageEl.style.color = colors[state] || 'var(--text-secondary)';
    }
    if (percentEl) percentEl.textContent = `${normalized}%`;
}

function _reelsCancelUnfinishedJobProgressUI() {
    const list = document.getElementById('reels-export-job-progress-list');
    if (!list) return;
    list.querySelectorAll('[data-job-index]').forEach((row) => {
        if (row.dataset.jobState === 'success' || row.dataset.jobState === 'failed') return;
        const pct = parseFloat((row.querySelector('[data-role="percent"]') || {}).textContent) || 0;
        _reelsUpdateJobProgressUI(Number(row.dataset.jobIndex), pct, '已取消', 'canceled');
    });
}

function _reelsParentDir(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    const normalized = filePath.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) return normalized;
    return normalized.slice(0, idx);
}

function _readPreferredReelsOutputDir() {
    try { return window.electronAPI?.readReelsOutputDirectory?.() || localStorage.getItem('reels_last_output_dir') || ''; } catch (_) { return ''; }
}
function _rememberReelsOutputDir(dir) {
    if (!dir || !String(dir).trim()) return;
    const value = String(dir).trim();
    const result = window.electronAPI?.saveReelsOutputDirectory?.(value);
    if (result?.ok === false) { alert(`输出目录记忆失败：${result.error}`); return; }
    try { localStorage.setItem('reels_last_output_dir', value); } catch (_) { }
}
function reelsSelectOutputDir() {
    if (window.electronAPI && window.electronAPI.selectDirectory) {
        window.electronAPI.selectDirectory().then(dir => {
            if (dir) {
                document.getElementById('reels-output-dir').value = dir;
                _rememberReelsOutputDir(dir);
            }
        });
    } else {
        alert('输出目录选择需要在 Electron 环境中运行');
    }
}

async function reelsOpenOutputDir() {
    let outputDir = (document.getElementById('reels-output-dir') || {}).value || '';
    if (!outputDir) outputDir = await _getSystemDownloadsPath();
    if (!outputDir) {
        alert('暂无可打开的输出目录');
        return;
    }
    if (window.electronAPI && window.electronAPI.apiCall) {
        try {
            await window.electronAPI.apiCall('file/open-folder', { path: outputDir });
        } catch (e) {
            alert(`打开目录失败: ${e.message || e}`);
        }
        return;
    }
    alert('打开目录需要在 Electron 环境中运行');
}

async function reelsOpenLastOutputInFolder() {
    const outputPath = _reelsState.lastExportOutputPath;
    if (!outputPath) {
        alert('暂无导出文件');
        return;
    }
    const folder = _reelsParentDir(outputPath);
    if (!folder) {
        alert('无法识别输出目录');
        return;
    }
    if (window.electronAPI && window.electronAPI.apiCall) {
        try {
            await window.electronAPI.apiCall('file/open-folder', { path: folder });
        } catch (e) {
            alert(`打开目录失败: ${e.message || e}`);
        }
        return;
    }
    alert('打开目录需要在 Electron 环境中运行');
}

async function _reelsComposeViaBackend(params) {
    if (window.electronAPI && typeof window.electronAPI.reelsCompose === 'function') {
        try {
            const resp = await window.electronAPI.reelsCompose(params);
            if (!resp || resp.success === false) {
                throw new Error((resp && resp.error) || 'Reels 合成失败');
            }
            return resp;
        } catch (err) {
            const msg = err && err.message ? err.message : String(err || '');
            // 主进程未重启时，可能出现该错误；回退尝试旧通道。
            if (!msg.includes("No handler registered for 'reels-compose'")) {
                throw err;
            }
        }
    }
    if (window.electronAPI && window.electronAPI.apiCall) {
        const resp = await window.electronAPI.apiCall('media/reels-compose', params);
        if (!resp || !resp.success) {
            const errMsg = (resp && resp.error) || 'Reels 合成失败';
            if (String(errMsg).includes('未知接口: media/reels-compose')) {
                throw new Error('当前主进程版本不一致（缺少导出接口）。请先完全退出所有 VideoKit 进程，再只启动一个实例重试');
            }
            throw new Error(errMsg);
        }
        return resp;
    }
    throw new Error('缺少后端导出能力（Electron API 不可用）');
}

async function reelsSelectIntro() {
    const filePath = await _pickSingleFile('选择全局前置片段', ['mp4', 'mov', 'mkv', 'webm', 'm4v']);
    if (filePath) document.getElementById('reels-intro-path').value = filePath;
}

function _initReelsIntroInput() {
    const input = document.getElementById('reels-intro-path');
    if (!input || input.dataset.dropBound === 'true') return;
    input.dataset.dropBound = 'true';
    input.title = '点击选择，或把视频文件拖到这里';
    input.style.cursor = 'pointer';
    input.addEventListener('click', reelsSelectIntro);

    const reset = () => {
        input.style.outline = '';
        input.style.background = '';
    };
    ['dragenter', 'dragover'].forEach(type => input.addEventListener(type, event => {
        event.preventDefault();
        event.stopPropagation();
        input.style.outline = '1px solid var(--accent)';
        input.style.background = 'rgba(76,158,255,.08)';
    }));
    ['dragleave', 'drop'].forEach(type => input.addEventListener(type, reset));
    input.addEventListener('drop', event => {
        event.preventDefault();
        event.stopPropagation();
        const file = Array.from(event.dataTransfer?.files || [])[0];
        if (!file) return;
        if (!/\.(mp4|mov|mkv|webm|m4v)$/i.test(file.name || '')) {
            showToast('前置片段请选择视频文件', 'error');
            return;
        }
        const filePath = window.electronAPI?.getFilePath?.(file) || file.path || '';
        if (!filePath) {
            showToast('无法读取拖入文件的本地路径', 'error');
            return;
        }
        input.value = filePath;
    });
}

function reelsCancelExport() {
    try { localStorage.removeItem(REELS_EXPORT_RESUME_KEY); } catch (_) { }
    if (_reelsState.isExporting) {
        _reelsState.isExporting = false;
        _reelsCancelUnfinishedJobProgressUI();
        const statusEl = document.getElementById('reels-export-status');
        if (statusEl) statusEl.textContent = '⚠️ 已取消';
        const exportBtn = document.getElementById('reels-export-btn');
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.innerHTML = '🚀 开始导出';
        }
    }
}

// ═══════════════════════════════════════════════════════
// Export Selection (勾选导出)
// ═══════════════════════════════════════════════════════

/** 切换单个任务的导出选中状态 */
function reelsToggleExportSelect(idx, checked) {
    const task = _reelsState.tasks[idx];
    if (task) task._exportSelected = !!checked;
    _renderTaskList({ preserveScroll: true });
}
window.reelsToggleExportSelect = reelsToggleExportSelect;

/** 全选 / 取消全选 */
function reelsToggleExportSelectAll(checked) {
    _reelsState.tasks.forEach(t => t._exportSelected = !!checked);
    _renderTaskList({ preserveScroll: true });
}
window.reelsToggleExportSelectAll = reelsToggleExportSelectAll;

/** 更新已选计数 UI */
function _updateExportSelectedCountUI() {
    const tasks = _reelsState.tasks;
    const total = tasks.length;
    const selected = tasks.filter(t => t._exportSelected !== false).length;
    const countEl = document.getElementById('reels-export-selected-count');
    if (countEl) {
        if (total === 0) {
            countEl.textContent = '';
        } else if (selected === total) {
            countEl.textContent = `全部 ${total}`;
            countEl.style.color = 'var(--accent,#7b8bef)';
        } else {
            countEl.textContent = `已选 ${selected}/${total}`;
            countEl.style.color = selected === 0 ? '#f87171' : '#ffa502';
        }
    }
    // 同步全选 checkbox 状态
    const selectAllCb = document.getElementById('reels-export-select-all');
    if (selectAllCb) {
        selectAllCb.checked = total > 0 && selected === total;
        selectAllCb.indeterminate = selected > 0 && selected < total;
    }
    // 同步多模板矩阵预计
    if (typeof _updateMultiPresetSummary === 'function') {
        _updateMultiPresetSummary();
    }
}

function _sanitizeReelsFileBaseName(name, fallback = 'reel') {
    let base = String(name || '').trim()
        .replace(/\.[^.\\/]+$/, '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[<>:"/\\|?*]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    base = base.replace(/[. ]+$/g, '').trim();
    return base || fallback;
}

function _reelsPathBaseName(filePath) {
    if (!filePath) return '';
    const last = String(filePath).replace(/\\/g, '/').split('/').pop() || '';
    return _sanitizeReelsFileBaseName(last, '');
}

function _reelsTaskTextBaseName(task) {
    let text = String(task?.txtContent || task?.aiScript || task?.ttsText || '')
        .replace(/[\r\n\t]+/g, '')
        .trim();
    // 若主文案字段为空，尝试从覆层文字卡片中提取标题/正文作为命名
    if (!text && Array.isArray(task?.overlays)) {
        for (const ov of task.overlays) {
            if (!ov || ov.fixed_text) continue;
            const t = String(ov.title_text || '').trim();
            const b = String(ov.body_text || '').trim();
            if (t || b) {
                text = (t && b) ? `${t}_${b}` : (t || b);
                text = text.replace(/[\r\n\t]+/g, '').trim();
                break;
            }
        }
    }
    return text ? _sanitizeReelsFileBaseName(text.substring(0, 50), '') : '';
}

function _reelsTaskBackgroundBaseName(task) {
    return _reelsPathBaseName(task?.bgPath || task?.videoPath || '');
}

function _reelsTaskAudioBaseName(task) {
    return _reelsPathBaseName(task?.audioPath || '');
}

function _reelsTaskCardBaseName(task) {
    return _sanitizeReelsFileBaseName(task?.baseName || task?.fileName || '', '');
}

function _resolveReelsExportBaseName(task, namingMode = 'text') {
    const manual = _sanitizeReelsFileBaseName(task?.exportName || '', '');
    let base = '';
    if (manual) {
        base = manual;
    } else {
        const mode = namingMode || 'text';
        const byMode = mode === 'background'
            ? _reelsTaskBackgroundBaseName(task)
            : mode === 'audio'
                ? _reelsTaskAudioBaseName(task)
                : mode === 'card'
                    ? _reelsTaskCardBaseName(task)
                    : mode === 'custom'
                        ? ''
                        : _reelsTaskTextBaseName(task);
        if (byMode) {
            base = byMode;
        } else {
            base = _reelsTaskTextBaseName(task)
                || _reelsTaskBackgroundBaseName(task)
                || _reelsTaskAudioBaseName(task)
                || _reelsTaskCardBaseName(task)
                || _sanitizeReelsFileBaseName(task?.fileName || task?.baseName || 'reel');
        }
    }

    if (task?.versionTag) {
        const tag = _sanitizeReelsFileBaseName(String(task.versionTag).trim(), '');
        if (tag && !base.endsWith(`_${tag}`)) {
            base = `${base}_${tag}`;
        }
    }

    return base;
}
window._resolveReelsExportBaseName = _resolveReelsExportBaseName;

// ═══════════════════════════════════════════════════════
// Cover PNG Export Utility
// ═══════════════════════════════════════════════════════
async function _exportSaveCoverPng(task, outputDirTrimmed, baseName) {
    if (!task.cover || !task.cover.enabled || task.cover.exportSeparate === false) return null;

    try {
        const tw = _reelsState.targetWidth || 1080;
        const th = _reelsState.targetHeight || 1920;
        const offCanvas = document.createElement('canvas');
        offCanvas.width = tw;
        offCanvas.height = th;
        const ctx = offCanvas.getContext('2d');

        // Draw cover background
        let bgImg = null;
        if (task.cover.bgPath) {
            const isVideo = /\.(mp4|mov|mkv|webm)$/i.test(task.cover.bgPath);
            if (isVideo) {
                bgImg = await new Promise((resolve) => {
                    const vid = document.createElement('video');
                    vid.crossOrigin = 'anonymous';
                    vid.muted = true;
                    vid.onloadeddata = () => { vid.currentTime = 0.05; };
                    vid.onseeked = () => resolve(vid);
                    vid.onerror = () => resolve(null);
                    vid.src = _toPlayablePath(task.cover.bgPath, null);
                });
            } else {
                bgImg = await new Promise((resolve) => {
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.onload = () => resolve(img);
                    img.onerror = () => resolve(null);
                    img.src = _toPlayablePath(task.cover.bgPath, null);
                });
            }
        }
        
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, tw, th);
        if (bgImg) {
            _drawVideoCover(ctx, bgImg, tw, th, task.cover.bgScale || task.bgScale || 100, task.cover.bgX || task.bgX || 0, task.cover.bgY || task.bgY || 0);
        }

        // Draw Cover overlays
        const showOverlay = _isReelsOverlayToggleEnabled();
        if (showOverlay && task.cover.overlays && task.cover.overlays.length > 0 && window.ReelsOverlay) {
            for (const ov of task.cover.overlays) {
                if (ov.disabled) continue;
                ov._exporting = true;
                ReelsOverlay.drawOverlay(ctx, ov, 0, tw, th);
                ov._exporting = false;
            }
        }

        if (typeof _drawWatermarks === 'function') {
            _drawWatermarks(ctx, tw, th);
        }


        const dataUrl = offCanvas.toDataURL('image/png');
        const outputPath = `${outputDirTrimmed}/${baseName}_封面.png`;

        if (window.electronAPI && window.electronAPI.apiCall) {
            await window.electronAPI.apiCall('file/write-base64', { path: outputPath, content: dataUrl });
        }
        return outputPath;
    } catch (e) {
        console.error('[Export Cover] Error:', e);
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// Cover MP4 Export Utility
// ═══════════════════════════════════════════════════════
async function _exportCoverVideo(task, taskStyle, outputDirTrimmed, baseName) {
    if (!task.cover || !task.cover.enabled || !task.cover.duration || parseFloat(task.cover.duration) <= 0) return null;
    try {
        const tw = _reelsState.targetWidth || 1080;
        const th = _reelsState.targetHeight || 1920;
        const offCanvas = document.createElement('canvas');
        offCanvas.width = tw;
        offCanvas.height = th;
        const outputPath = `${outputDirTrimmed}/temp_${baseName}_cover_piece.mp4`;
        let exportEngine = (document.getElementById('reels-export-engine') || {}).value || 'precise';
        if (exportEngine === 'experimental') exportEngine = 'hardware';
        const gpuEnabled = (document.getElementById('reels-use-gpu') || {}).checked || exportEngine === 'hardware';
        const showOverlay = _isReelsOverlayToggleEnabled();
        
        await window.reelsWysiwygExport({
            canvas: offCanvas,
            style: taskStyle,
            segments: [],
            overlays: showOverlay ? (task.cover.overlays || []) : [],
            backgroundPath: task.cover.bgPath || task.bgPath,
            bgMode: 'single',
            outputPath: outputPath,
            customDuration: parseFloat(task.cover.duration),
            fps: 30,
            voiceVolume: 0,
            bgVolume: 0,
            bgScale: task.cover.bgScale || task.bgScale || 100,
            bgRotation: task.cover.bgRotation ?? task.bgRotation ?? 0,
            bgX: task.cover.bgX || task.bgX || 0,
            bgY: task.cover.bgY || task.bgY || 0,
            bgFlipH: task.cover.bgFlipH || task.bgFlipH || false,
            bgFlipV: task.cover.bgFlipV || task.bgFlipV || false,
            targetWidth: tw,
            targetHeight: th,
            exportEngine,
            useGPU: gpuEnabled,
        });
        return outputPath;
    } catch (e) {
        console.error('[Export Cover Video] Error:', e);
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// Multi-Preset Matrix Export
// ═══════════════════════════════════════════════════════

function _initMultiPresetUI() {
    const enabledCb = document.getElementById('reels-multi-preset-enabled');
    const toggleBtn = document.getElementById('reels-multi-preset-toggle');
    const panel = document.getElementById('reels-multi-preset-panel');
    const summary = document.getElementById('reels-multi-preset-summary');
    if (!enabledCb) return;

    const updateVisibility = () => {
        const on = enabledCb.checked;
        if (toggleBtn) toggleBtn.style.display = on ? '' : 'none';
        if (summary) summary.style.display = on ? '' : 'none';
        if (!on && panel) panel.style.display = 'none';
        if (on) _refreshMultiPresetList();
    };

    enabledCb.addEventListener('change', updateVisibility);

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            if (!panel) return;
            const isOpen = panel.style.display !== 'none';
            panel.style.display = isOpen ? 'none' : '';
            toggleBtn.textContent = isOpen ? '展开选择...' : '收起';
            if (!isOpen) _refreshMultiPresetList();
        });
    }

    // Select/Deselect/Invert
    document.getElementById('reels-mp-select-all')?.addEventListener('click', () => {
        panel?.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
        _updateMultiPresetSummary();
    });
    document.getElementById('reels-mp-deselect')?.addEventListener('click', () => {
        panel?.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        _updateMultiPresetSummary();
    });
    document.getElementById('reels-mp-invert')?.addEventListener('click', () => {
        panel?.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = !cb.checked);
        _updateMultiPresetSummary();
    });
}

function _refreshMultiPresetList() {
    const listEl = document.getElementById('reels-mp-preset-list');
    if (!listEl) return;

    // Reuse batch-table's helper to get all overlay group presets
    let presetNames = [];
    try {
        const stored = localStorage.getItem('reels_overlay_group_presets');
        let obj = stored ? JSON.parse(stored) : {};
        if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
            obj = { ...window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS, ...obj };
        }
        presetNames = Object.keys(obj);
    } catch(e) {}

    if (presetNames.length === 0) {
        listEl.innerHTML = '<span style="font-size:11px;color:#888;">暂无覆层预设，请先在覆层面板中保存预设</span>';
        return;
    }

    const builtInKeys = window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS ? Object.keys(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) : [];

    listEl.innerHTML = presetNames.map(name => {
        const isBuiltin = builtInKeys.includes(name);
        const tagColor = isBuiltin ? 'rgba(100,200,150,0.15)' : 'rgba(123,139,239,0.1)';
        const tagText = isBuiltin ? '内置' : '自定义';
        const tagFg = isBuiltin ? '#6cc' : '#8b8bfa';
        const safeName = String(name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        return `<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;cursor:pointer;padding:3px 6px;border-radius:4px;background:${tagColor};white-space:nowrap;">
            <input type="checkbox" class="reels-mp-cb" data-preset-name="${safeName}" style="margin:0;transform:scale(0.85);">
            <span style="font-size:9px;color:${tagFg};font-weight:600;">[${tagText}]</span>
            ${safeName}
        </label>`;
    }).join('');

    // Bind change events
    listEl.querySelectorAll('.reels-mp-cb').forEach(cb => {
        cb.addEventListener('change', () => _updateMultiPresetSummary());
    });
}

function _updateMultiPresetSummary() {
    const selected = _getSelectedMultiPresets();
    const summary = document.getElementById('reels-multi-preset-summary');
    const estimate = document.getElementById('reels-mp-estimate');
    // 使用已勾选导出的任务数
    const taskCount = (_reelsState.tasks || []).filter(t => t._exportSelected !== false).length;
    
    if (summary) {
        summary.textContent = selected.length > 0 ? `已选 ${selected.length} 个模板` : '未选择模板';
    }
    if (estimate) {
        if (selected.length > 0 && taskCount > 0) {
            estimate.style.display = '';
            estimate.textContent = `📊 预计导出：${taskCount} 任务 × ${selected.length} 模板 = ${taskCount * selected.length} 个视频`;
        } else {
            estimate.style.display = 'none';
        }
    }
}

function _resolveSafeReelsExportConcurrency(requested, totalJobs, options = {}) {
    const wanted = Math.max(1, Math.min(10, parseInt(requested, 10) || 1));
    // 导出并发由用户选择；不要根据内存解码器或队列长度静默降级。
    return wanted;
}

function _sanitizeReelsExportRecycleEvery(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return REELS_EXPORT_RECYCLE_EVERY_DEFAULT;
    return Math.min(9999, parsed);
}

function _getReelsExportRecycleEvery() {
    return _sanitizeReelsExportRecycleEvery(document.getElementById('reels-export-recycle-every')?.value);
}

function _getSelectedMultiPresets() {
    const cbs = document.querySelectorAll('.reels-mp-cb:checked');
    return Array.from(cbs).map(cb => cb.getAttribute('data-preset-name')).filter(Boolean);
}

/**
 * 获取多模板矩阵导出配置
 * @returns {null|{presets: string[], naming: string}} null 表示未启用
 */
function _getMultiPresetConfig() {
    const enabled = document.getElementById('reels-multi-preset-enabled');
    if (!enabled || !enabled.checked) return null;
    const presets = _getSelectedMultiPresets();
    if (presets.length === 0) return null;
    const naming = (document.getElementById('reels-mp-naming') || {}).value || 'flat';
    return { presets, naming };
}

function reelsUpdateCustomBitrateUI() {
    const quality = (document.getElementById('reels-quality') || {}).value || 'low';
    const settingsEl = document.getElementById('reels-custom-bitrate-settings');
    if (settingsEl) settingsEl.style.display = quality === 'custom' ? 'inline-flex' : 'none';
    const presetRates = {
        high: { target: 12, max: 12 },
        medium: { target: 8, max: 11 },
        low: { target: 2, max: 3 },
        ultrafast: { target: 2.5, max: 3.5 },
    };
    const rates = quality === 'custom'
        ? _readReelsCustomBitrate()
        : (presetRates[quality] || presetRates.low);
    const label = document.getElementById('reels-quality-bitrate-label');
    if (label) label.textContent = `目标 ${rates.target} / 最大 ${rates.max} Mbps`;
}
window.reelsUpdateCustomBitrateUI = reelsUpdateCustomBitrateUI;

async function reelsUpdateExportEngineUI() {
    const engineEl = document.getElementById('reels-export-engine');
    let engine = (engineEl || {}).value || 'precise';
    if (engine === 'experimental') {
        engine = 'hardware';
        if (engineEl) engineEl.value = engine;
    }
    const desc = document.getElementById('reels-export-engine-desc');
    if (!desc) return;
    const descriptions = {
        precise: '逐帧确认，兼容优先',
        pipeline: '背景直通 + 三帧批量（保留透明过渡）',
        hardware: '背景直通 + 显卡编码（保留透明过渡）',
    };
    desc.textContent = descriptions[engine] || descriptions.precise;
    desc.style.color = 'var(--text-muted)';
    if (engine === 'hardware' && window.electronAPI?.reelsComposeWysiwyg) {
        desc.textContent = '正在检测硬件编码器…';
        try {
            const result = await window.electronAPI.reelsComposeWysiwyg('probe-gpu', {});
            if ((document.getElementById('reels-export-engine') || {}).value !== 'hardware') return;
            desc.textContent = result?.available
                ? `可用：${result.name || '硬件 H.264'}`
                : '未检测到硬件编码器，导出时回退 CPU';
            desc.style.color = result?.available ? '#52c41a' : '#faad14';
        } catch (_) {
            desc.textContent = '检测失败，导出时自动回退 CPU';
            desc.style.color = '#faad14';
        }
    }
}
window.reelsUpdateExportEngineUI = reelsUpdateExportEngineUI;

function _readReelsCustomBitrate() {
    let target = parseFloat((document.getElementById('reels-custom-bitrate') || {}).value || '5');
    let max = parseFloat((document.getElementById('reels-custom-max-bitrate') || {}).value || '7');
    if (!Number.isFinite(target)) target = 5;
    if (!Number.isFinite(max)) max = 7;
    target = Math.max(1, Math.min(30, target));
    max = Math.max(target, Math.min(50, max));
    return { target, max };
}

/**
 * 为导出创建一个临时任务副本，应用指定的覆层预设但保留原文案
 * @param {object} task 原始任务
 * @param {string} presetName 覆层预设名称
 * @returns {object} 深克隆后并应用了预设的任务副本
 */
function _cloneTaskWithPreset(task, presetName) {
    // 深克隆整个任务
    const clone = JSON.parse(JSON.stringify(task));
    // 使用 batch-table 中已有的完整逻辑来应用覆层预设
    // 这会保留文案内容，只替换视觉样式
    if (typeof _applyOverlayGroupPresetToTask === 'function') {
        _applyOverlayGroupPresetToTask(clone, presetName);
    }
    return clone;
}

/**
 * 导出队列只能持有任务快照，不能持有界面中的可变任务对象。
 * 字体加载、媒体探测和隐藏渲染窗口启动都是异步的；如果期间表格自动保存、
 * 覆层面板回写或时间线同步修改了原对象，同一 job 的视频路径和字幕/覆层就可能
 * 来自不同时间点。这里保留全部普通字段（包括任务/分组私有标记），仅剥离
 * DOM、函数和循环运行时缓存。
 */
function _cloneReelsTaskForExport(task) {
    const seen = new WeakSet();
    const cloneValue = (value) => {
        if (value === null || value === undefined) return value;
        if (['string', 'number', 'boolean'].includes(typeof value)) return value;
        if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined;
        if (typeof Element !== 'undefined' && value instanceof Element) return undefined;
        if (typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement) return undefined;
        if (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement) return undefined;
        if (typeof HTMLVideoElement !== 'undefined' && value instanceof HTMLVideoElement) return undefined;
        if (typeof Blob !== 'undefined' && value instanceof Blob) return undefined;
        if (value instanceof Date) return value.toISOString();
        if (typeof value !== 'object' || seen.has(value)) return undefined;
        seen.add(value);
        if (typeof value.toJSON === 'function') {
            const jsonValue = cloneValue(value.toJSON());
            seen.delete(value);
            return jsonValue;
        }
        if (Array.isArray(value)) {
            const result = value.map(cloneValue).filter(item => item !== undefined);
            seen.delete(value);
            return result;
        }
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            // These fields contain decoded media/Canvas state and must be rebuilt per renderer.
            if (['_allOverlays', '_imageEl', '_videoEl', '_img', '_currentFrameImage', 'canvas', 'ctx'].includes(key)) continue;
            const cloned = cloneValue(item);
            if (cloned !== undefined) result[key] = cloned;
        }
        seen.delete(value);
        return result;
    };
    const snapshot = cloneValue(task) || {};
    if (snapshot.bgSrcUrl && String(snapshot.bgSrcUrl).startsWith('blob:')) snapshot.bgSrcUrl = null;
    if (snapshot.srcUrl && String(snapshot.srcUrl).startsWith('blob:')) snapshot.srcUrl = null;
    return snapshot;
}

function _isAbsoluteReelsMediaPath(filePath) {
    const value = String(filePath || '');
    return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function _resolveTaskExportBackgroundPath(task) {
    const configured = task?.bgPath || task?.videoPath || '';
    if (_isAbsoluteReelsMediaPath(configured)) return configured;
    const sourceUrl = task?.bgSrcUrl || task?.srcUrl || '';
    if (sourceUrl && !String(sourceUrl).startsWith('blob:')) {
        const decoded = _normalizeLocalMediaPath(sourceUrl);
        if (_isAbsoluteReelsMediaPath(decoded)) return decoded;
    }
    return configured;
}

function _summarizeExportBinding(task) {
    const firstSegment = Array.isArray(task?.segments) ? task.segments.find(seg => String(seg?.text || '').trim()) : null;
    const firstOverlay = Array.isArray(task?.overlays) ? task.overlays.find(ov => ov && !ov.disabled) : null;
    const overlayText = firstOverlay
        ? (firstOverlay.title_text || firstOverlay.body_text || firstOverlay.content || firstOverlay.name || '')
        : '';
    const compact = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 36);
    return `id=${task?.id || '-'} | video=${String(task?.bgPath || task?.videoPath || '-').split(/[\\/]/).pop()} | subtitle="${compact(firstSegment?.text)}" | overlay="${compact(overlayText)}"`;
}

function _getAutoEditProjectScript(task) {
    const savedScript = String(task?.autoEditProject?.scriptText || '').trim();
    if (savedScript) return savedScript;
    return (Array.isArray(task?.segments) ? task.segments : [])
        .map(segment => String(segment?.edited_text || segment?.text || '').trim())
        .filter(Boolean)
        .join('\n');
}

function _collectReelsProjectMediaAssets() {
    const paths = new Set();
    const isAbsolutePath = value => typeof value === 'string'
        && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
    const visit = (value, key = '', seen = new WeakSet()) => {
        if (typeof value === 'string') {
            // 覆层文字同样使用 content 字段，因此只收集真正的绝对本地路径。
            if (isAbsolutePath(value) && /(?:path|src|content|media|file)$/i.test(key)) paths.add(value);
            return;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) value.forEach(item => visit(item, '', seen));
        else Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey, seen));
    };
    (_reelsState.tasks || []).forEach(task => visit(task.overlays || []));
    (_reelsState.watermarks || []).forEach(watermark => visit(watermark));
    return [...paths];
}

async function _copyAutoEditProjectToReelsOutput(task, finalOutputPath) {
    let sourceProjectDir = String(task?.autoEditProject?.collectionPath || '').trim();
    if (!sourceProjectDir) {
        const sourceOutputPath = String(task?.autoEditProject?.outputPath || task?.bgPath || '');
        const sourceBase = sourceOutputPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '';
        const sourceDir = sourceOutputPath.slice(0, Math.max(sourceOutputPath.lastIndexOf('/'), sourceOutputPath.lastIndexOf('\\')));
        if (sourceBase && sourceDir) {
            const sep = sourceDir.includes('\\') ? '\\' : '/';
            sourceProjectDir = `${sourceDir}${sep}${sourceBase}-工程`;
        }
    }
    if (!sourceProjectDir || !finalOutputPath || !window.electronAPI?.copyReelsProjectPackage) return { skipped: true };
    let reelsProjectData = null;
    try {
        reelsProjectData = window.ReelsProject?.collectProjectData?.(_reelsState) || null;
    } catch (error) {
        console.warn('[Reels] 收集当前 Reels 工程快照失败:', error);
    }
    return window.electronAPI.copyReelsProjectPackage({
        sourceProjectDir,
        outputPath: finalOutputPath,
        scriptText: _getAutoEditProjectScript(task),
        reelsProjectData,
        overlayAssets: _collectReelsProjectMediaAssets(),
        analysisAssets: [task?.autoEditProject?.analysisProjectPath, task?.autoEditProject?.analysisReportPath].filter(Boolean),
        analysisOutputDir: task?.autoEditProject?.analysisOutputDir || '',
        originalClips: Array.isArray(task?.autoEditProject?.originalClips) ? task.autoEditProject.originalClips : [],
    });
}

async function reelsPackageSelectedProjects() {
    const packButton = document.getElementById('reels-package-project-btn');
    const statusEl = document.getElementById('reels-export-status');
    const tasks = (_reelsState.tasks || []).filter(task => task._exportSelected !== false && task.autoEditProject);
    if (!tasks.length) {
        showToast?.('没有可打包的自动剪辑任务；请先将文案自动剪辑成片送入 Reels', 'info');
        return;
    }
    let outputDir = String(document.getElementById('reels-output-dir')?.value || '');
    if (!outputDir) {
        outputDir = await _getSystemDownloadsPath();
        const outputEl = document.getElementById('reels-output-dir');
        if (outputEl) outputEl.value = outputDir || '';
    }
    if (!outputDir) return showToast?.('请先选择工程包输出目录', 'warning');
    const ensure = await window.electronAPI?.ensureDirectory?.(outputDir);
    if (ensure?.ok === false) return showToast?.(`无法创建输出目录：${ensure.error || outputDir}`, 'error');
    const sep = outputDir.includes('\\') ? '\\' : '/';
    const baseDir = outputDir.replace(/[\\/]+$/, '');
    let succeeded = 0;
    const failures = [];
    const previousButtonText = packButton?.textContent || '📦 仅打包工程';
    if (packButton) { packButton.disabled = true; packButton.textContent = '📦 打包中…'; }
    if (statusEl) statusEl.textContent = `📦 正在打包工程 0/${tasks.length}…`;
    showToast?.(`开始打包 ${tasks.length} 个工程；大视频素材复制期间请勿关闭窗口`, 'info', 5000);
    try {
        for (let index = 0; index < tasks.length; index++) {
            const task = tasks[index];
            const rawName = task.exportName || task.baseName || task.fileName || 'Reels工程';
            const safeName = _sanitizeReelsFileBaseName(rawName, 'Reels工程');
            if (statusEl) statusEl.textContent = `📦 正在打包工程 ${index + 1}/${tasks.length}：${safeName}`;
            const virtualOutputPath = `${baseDir}${sep}${safeName}.mp4`;
            const result = await _copyAutoEditProjectToReelsOutput(task, virtualOutputPath);
            if (result?.ok) succeeded++;
            else failures.push(`${task.fileName || safeName}：${result?.error || '原工程文件夹不存在'}`);
        }
    } catch (error) {
        failures.push(`打包流程：${error?.message || error}`);
    } finally {
        if (packButton) { packButton.disabled = false; packButton.textContent = previousButtonText; }
    }
    if (statusEl) statusEl.textContent = failures.length
        ? `⚠️ 工程打包完成 ${succeeded}/${tasks.length}，有 ${failures.length} 个失败`
        : `✅ 工程打包完成 ${succeeded}/${tasks.length}`;
    if (succeeded) showToast?.(`已打包 ${succeeded}/${tasks.length} 个工程到当前输出目录（未重新导出视频）`, failures.length ? 'warning' : 'success', 7000);
    if (failures.length) {
        console.warn('[Reels] 仅打包工程失败:', failures);
        showToast?.(`有 ${failures.length} 个工程未打包成功，请查看控制台详情`, 'warning', 7000);
    }
}
window.reelsPackageSelectedProjects = reelsPackageSelectedProjects;

// 初始化（需要在 DOM 就绪后调用）
setTimeout(() => _initMultiPresetUI(), 200);

async function reelsStartExport(options = {}) {
    const resumeState = options && options.resumeState ? options.resumeState : null;
    const workMode = _getWorkMode();
    
    if (!resumeState && !localStorage.getItem('reelsQualityReminderShown')) {
        const proceed = confirm("【画质选择提醒】\\n\\n画质档位会显示目标码率和最大码率：\\n\\n• 口播低质量（默认 2/3 Mbps）：固定机位、人物和背景运动少\\n• 口播高质量（8/11 Mbps）：绿幕、细节多或人物动作较多\\n• Reels高质量（12 Mbps）：动态背景、转场和运动镜头\\n• 自定义码率：按需要手动设置\\n\\n建议先导出一个片段确认画质。您要继续当前导出吗？（本提示仅显示一次）");
        if (!proceed) return;
        localStorage.setItem('reelsQualityReminderShown', 'true');
    }

    // 明确告知导出会沿用哪些非默认设置，避免用户忘记上次保存过的参数。
    const customSettings = _getReelsExportCustomSettingsSummary();
    if (!resumeState && customSettings.length > 0) {
        const preview = customSettings.slice(0, 12).join('、');
        const remaining = customSettings.length > 12 ? ` 等 ${customSettings.length} 项` : '';
        const proceed = confirm(`本次导出将使用已修改并保存的设置：\n\n${preview}${remaining}\n\n确认继续导出？`);
        if (!proceed) return;
    }

    // ── 导出前同步当前任务的覆层（用户可能删除/修改了覆层但尚未切换任务） ──
    _syncCurrentOverlayEditorToSelectedTask();

    // 导出前自动对齐未对齐的 TXT 任务
    if (workMode !== 'srt') {
        const unaligned = _reelsState.tasks.filter(t =>
            t.txtContent && !t.aligned && (t.segments || []).length === 0
        );
        if (unaligned.length > 0) {
            const statusEl = document.getElementById('reels-export-status');
            if (statusEl) statusEl.textContent = `正在对齐 ${unaligned.length} 个任务...`;
            for (let i = 0; i < unaligned.length; i++) {
                const task = unaligned[i];
                if (statusEl) statusEl.textContent = `对齐中 ${i + 1}/${unaligned.length}: ${task.fileName}`;
                try { await _reelsAlignSubtitles(task); } catch (err) {
                    console.error('[Reels] Pre-export align failed:', task.fileName, err);
                }
            }
            _renderTaskList();
        }
    }

    let customDuration = parseFloat((document.getElementById('reels-custom-duration') || {}).value || '0');
    if (!Number.isFinite(customDuration) || customDuration < 0) customDuration = 0;

    // ── 仅导出已勾选的任务 ──
    const selectedForExport = _reelsState.tasks.filter(t => t._exportSelected !== false);
    if (selectedForExport.length === 0) {
        if (typeof showToast === 'function') {
            showToast('没有选中任何任务用于导出。请在任务列表中勾选要导出的任务。', 'warning');
        } else {
            alert('没有选中任何任务用于导出。请在任务列表中勾选要导出的任务。');
        }
        return;
    }

    const invalidTasks = [];
    const tasks = selectedForExport.filter((t, idx) => {
        const hasSub = !!t.srtPath && (t.segments || []).length > 0;
        const bgPath = t.bgPath || t.videoPath;
        const hasMultiClip = t.bgMode === 'multi' && _getEffectiveBgClipPool(t).length > 0;
        const hasBg = !!bgPath || hasMultiClip;
        const hasVoice = !!t.audioPath;
        // 有覆层（文字卡片 或 滚动字幕）则不强制要求字幕
        const hasOverlay = Array.isArray(t.overlays) && t.overlays.some(ov =>
            ov && (
                String(ov.title_text || '').trim() ||
                String(ov.body_text || '').trim() ||
                String(ov.footer_text || '').trim() ||
                String(ov.content || '').trim() ||
                String(ov.scroll_title || '').trim() ||
                String(ov.scroll_body || '').trim()
            )
        );
        // 有任意覆层（包括图片/视频覆层，无需文字内容）
        const hasAnyOverlay = Array.isArray(t.overlays) && t.overlays.some(ov => ov && !ov.disabled);

        if (workMode === 'voiced_bg') {
            // 带声视频模式：需要背景 + (字幕 或 文字卡片)
            // 但如果只有背景视频（无字幕无覆层），也允许导出（直出视频）
            if (!hasBg) {
                invalidTasks.push(`${idx + 1}. ${(t.fileName || t.baseName || '未命名任务')} 缺少: 带声视频`);
                return false;
            }
            return true;
        }

        // SRT 模式和配音+文本模式
        // 允许导出条件放宽：有背景即可（无字幕时导出纯视频+覆层）
        if (!hasBg) {
            invalidTasks.push(`${idx + 1}. ${(t.fileName || t.baseName || '未命名任务')} 缺少: 背景`);
            return false;
        }

        // ── 多素材模式：背景素材本身即可确定输出时长 ──
        // 导出引擎会读取每段视频的真实时长并求和，再扣除转场重叠；
        // 图片素材按默认展示时长计算，因此无需字幕、配音或覆层也能直出。
        if (t.bgMode === 'multi') {
            return true;
        }

        // 有字幕、有文字覆层、有任意覆层 => 直接通过
        if (hasSub || hasOverlay || hasAnyOverlay) {
            if (hasVoice) return true;
            // 有文字卡片但无配音/字幕，也允许导出
            if ((hasOverlay || hasAnyOverlay) && !hasSub && !hasVoice) {
                return true;
            }
            // 无配音时仅兼容视频背景（旧模式）
            const allowNoVoice = !_isImagePath(bgPath);
            if (!allowNoVoice) {
                invalidTasks.push(`${idx + 1}. ${(t.fileName || t.baseName || '未命名任务')} 缺少: 人声音频（图片背景添加字幕时必须配合音频以确定字幕时间轴与总时长）`);
            }
            return allowNoVoice;
        }
        // 无字幕 + 无覆层：视频背景允许直出，图片背景需配音确定时长
        if (!_isImagePath(bgPath)) {
            return true; // 视频背景直出
        }
        if (hasVoice) {
            return true; // 有配音可以确定时长
        }
        invalidTasks.push(`${idx + 1}. ${(t.fileName || t.baseName || '未命名任务')} 缺少: 字幕、人声音频或覆层卡片（图片背景需要添加字幕+音频、或仅人声音频、或覆层卡片才能确定导出内容与时长）`);
        return false;
    });

    if (tasks.length === 0) {
        const extra = invalidTasks.length > 0 ? `\n\n任务问题:\n${invalidTasks.slice(0, 8).join('\n')}` : '';
        const msg = `没有可导出的任务${extra}`;
        _reelsUpdateLastErrorUI(msg);

        const statusEl = document.getElementById('reels-export-status');
        if (statusEl) statusEl.textContent = `❌ 导出失败: ${msg.replace(/\n/g, ' ')}`;

        const exportBtn = document.getElementById('reels-export-btn');
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.innerHTML = '🚀 开始导出';
        }
        _reelsState.isExporting = false;

        if (typeof showToast === 'function') {
            showToast('没有可导出的任务，请在下方“最后错误”查看详情', 'error');
        } else {
            alert(msg);
        }
        return;
    }

    let outputDir = document.getElementById('reels-output-dir').value;
    if (!outputDir) {
        outputDir = await _getSystemDownloadsPath();
        const outputEl = document.getElementById('reels-output-dir');
        if (outputEl) outputEl.value = outputDir || '';
    }
    if (!outputDir) { alert('请先选择输出目录'); return; }

    const quality = document.getElementById('reels-quality').value;
    let exportEngine = (document.getElementById('reels-export-engine') || {}).value || 'precise';
    if (exportEngine === 'experimental') exportEngine = 'hardware';
    const suffix = document.getElementById('reels-suffix').value || '_subtitled';
    const copyProjectToOutput = !!document.getElementById('reels-copy-project-to-output')?.checked;
    const namingMode = (document.getElementById('reels-export-naming-mode-outer') || {}).value || (document.getElementById('reels-naming-mode') || {}).value || localStorage.getItem('reels_naming_mode') || 'text';
    // 导出前只同步当前界面选中任务在 UI 中的微调，切勿跨任务强行覆盖其他任务的独立样式与模板
    const currentTaskForSync = _getSelectedTask();
    if (currentTaskForSync) {
        currentTaskForSync.subtitleStyle = _cloneSubtitleStyle(_readStyleFromUI());
    }
    const crfMap = { high: 15, medium: 18, low: 23, ultrafast: 26 };
    const presetMap = { high: 'medium', medium: 'fast', low: 'faster', ultrafast: 'ultrafast' };
    const crf = crfMap[quality] || 23;
    const qualityPreset = presetMap[quality] || 'faster';
    const customBitrate = quality === 'custom' ? _readReelsCustomBitrate() : null;
    const targetBitrateMbps = customBitrate ? customBitrate.target : null;
    const maxBitrateMbps = customBitrate ? customBitrate.max : null;
    const useKaraoke = document.getElementById('reels-karaoke-hl');
    const karaokeHL = useKaraoke ? useKaraoke.checked : false;
    let voiceVolume = parseFloat((document.getElementById('reels-voice-volume') || {}).value || '100');
    let bgVolume = _getGlobalBgVolumePercent();
    let bgmVolume = _getGlobalBgmVolumePercent();
    if (!Number.isFinite(voiceVolume)) voiceVolume = 100;
    if (!Number.isFinite(bgVolume)) bgVolume = 100;
    if (!Number.isFinite(bgmVolume)) bgmVolume = 30;
    voiceVolume = Math.max(0, voiceVolume);
    bgVolume = Math.max(0, bgVolume);
    bgmVolume = Math.max(0, bgmVolume);
    const loopFadeEl = document.getElementById('reels-loop-fade');
    const loopFade = loopFadeEl ? loopFadeEl.checked : true;
    const loopFadeDurEl = document.getElementById('reels-loop-fade-dur');
    let loopFadeDur = parseFloat(loopFadeDurEl ? loopFadeDurEl.value : '1');
    if (!Number.isFinite(loopFadeDur) || loopFadeDur <= 0) loopFadeDur = 1.0;
    loopFadeDur = Math.max(0.1, Math.min(3, loopFadeDur));
    customDuration = parseFloat((document.getElementById('reels-custom-duration') || {}).value || '0');
    if (!Number.isFinite(customDuration) || customDuration < 0) customDuration = 0;

    const exportFormat = (document.getElementById('reels-export-format') || {}).value || 'mp4';
    const doFcpxml = exportFormat === 'fcpxml' || exportFormat === 'fcpxml-compound';
    const fcpxmlCompound = exportFormat === 'fcpxml-compound';
    const fcpxmlBatchTasks = [];

    _reelsState.isExporting = true;
    const progressBar = document.getElementById('reels-export-progress');
    const statusEl = document.getElementById('reels-export-status');
    const exportBtn = document.getElementById('reels-export-btn');
    const exportBar = document.querySelector('.nle-export-bar');
    if (exportBar) exportBar.open = true;
    _reelsState.lastExportOutputPath = '';
    _reelsUpdateLastOutputUI('');
    _reelsUpdateLastErrorUI('');
    _reelsResetExportLogUI();
    _reelsAppendExportLogUI(`开始导出：已选 ${tasks.length} 个任务，输出目录：${outputDir}`);
    // Progress UI initialized after multi-preset matrix expansion below

    if (progressBar) progressBar.classList.remove('hidden');
    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.innerHTML = '⏳ 导出中...';
    }
    const useGPU = document.getElementById('reels-use-gpu');
    const gpuEnabled = useGPU ? useGPU.checked : false;
    const useMemoryDecoder = document.getElementById('reels-use-memory-decoder');
    const memoryDecoderEnabled = useMemoryDecoder ? useMemoryDecoder.checked : false;
    const introPath = (document.getElementById('reels-intro-path') || {}).value || '';
    let failCount = 0;
    let okCount = 0;
    let canceled = false;
    const failDetails = [];
    const outputDirRaw = String(outputDir || '');
    const outputDirBase = outputDirRaw.replace(/[\\/]+$/, '') || outputDirRaw;
    const outputJoinSep = outputDirBase.includes('\\') ? '\\' : '/';

    // 自动创建带日期的子文件夹，如 "2026-03-02_批量Reels"
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const subFolderName = `${dateStr}_${timeStr}_批量Reels`;
    const outputDirTrimmed = resumeState?.outputDirTrimmed
        ? String(resumeState.outputDirTrimmed)
        : `${outputDirBase}${outputJoinSep}${subFolderName}`;

    const concurrencyInput = document.getElementById('reels-export-concurrency');
    const requestedConcurrency = resumeState?.requestedConcurrency
        ? Math.max(1, parseInt(resumeState.requestedConcurrency) || 1)
        : (concurrencyInput ? Math.max(1, parseInt(concurrencyInput.value) || 1) : 1);

    // ═══ 导出前并行预提取所有任务的音视频时长，确保循环计算与时长判断精确 ═══
    await Promise.all(tasks.map(t => _preFetchTaskMediaDurations(t)));

    // ═══ 自动补齐背景循环检查（杜绝导出画面不足或黑屏） ═══
    for (const task of tasks) {
        const subtitleDuration = Array.isArray(task.segments) && task.segments.length
            ? Math.max(0, ...task.segments.map(s => Number(s.end) || 0))
            : 0;
        const outputDuration = Math.max(subtitleDuration, _getAudioDuration(task), _getVideoDuration(task), _getContentVideoDuration(task), Number(task.duration) || 0, task.customDuration || 0, 1);
        if (window.ReelsRenderPlan?.fillBackgroundLoops(task, { duration: outputDuration })) {
            _reelsAppendExportLogUI(`[前置检查] 任务 "${task.baseName || task.fileName || 'Reels'}" 背景画面已自动补齐循环至 ${outputDuration.toFixed(1)}s`);
        }
    }

    // ═══ 多模板矩阵展开 ═══
    const multiPresetCfg = resumeState?.multiPresetCfg || _getMultiPresetConfig();
    const exportJobs = [];
    if (multiPresetCfg) {
        // 矩阵模式：tasks × presets
        for (const sourceTask of tasks) {
            for (const presetName of multiPresetCfg.presets) {
                let task = _cloneReelsTaskForExport(sourceTask);
                task = _cloneTaskWithPreset(task, presetName);
                exportJobs.push({
                    task,
                    subtitleStyle: _cloneSubtitleStyle(_resolveSubtitleStyleForTask(sourceTask)),
                    presetName,
                    naming: multiPresetCfg.naming,
                });
            }
        }
        console.log(`[Reels] 多模板矩阵导出: ${tasks.length} 任务 × ${multiPresetCfg.presets.length} 模板 = ${exportJobs.length} 个视频`);
    } else {
        // 常规模式：每任务一个 job
        for (const sourceTask of tasks) {
            exportJobs.push({
                task: _cloneReelsTaskForExport(sourceTask),
                subtitleStyle: _cloneSubtitleStyle(_resolveSubtitleStyleForTask(sourceTask)),
                presetName: null,
                naming: null,
            });
        }
    }
    const totalJobs = exportJobs.length;
    const exportJobKeys = exportJobs.map((job, index) => {
        const task = job.task || {};
        return [
            task.id || '', task._folderQueueId || '', task.audioPath || '',
            task.videoPath || task.bgPath || '', task.baseName || task.fileName || '',
            job.presetName || '', index,
        ].join('|');
    });
    if (resumeState) {
        const sameJobs = resumeState.totalJobs === totalJobs
            && JSON.stringify(resumeState.jobKeys || []) === JSON.stringify(exportJobKeys);
        if (!sameJobs) {
            try { localStorage.removeItem(REELS_EXPORT_RESUME_KEY); } catch (_) { }
            _reelsState.isExporting = false;
            if (exportBtn) { exportBtn.disabled = false; exportBtn.innerHTML = '🚀 开始导出'; }
            alert('导出队列在释放内存期间发生了变化，已停止自动续传。请重新点击导出。');
            return;
        }
    }
    const concurrency = _resolveSafeReelsExportConcurrency(requestedConcurrency, totalJobs, {
        doFcpxml,
        useMemoryDecoder: memoryDecoderEnabled,
        width: _reelsState.targetWidth || 1080,
        height: _reelsState.targetHeight || 1920,
    });
    const recycleEvery = _sanitizeReelsExportRecycleEvery(
        resumeState?.recycleEvery ?? _getReelsExportRecycleEvery()
    );
    if (!resumeState && !doFcpxml && totalJobs > recycleEvery && typeof showToast === 'function') {
        showToast(`长队列分段模式：段内并发 ${concurrency}，每 ${recycleEvery} 条刷新并自动续传`, 'info', 7000);
    }
    const resumeManifest = {
        version: 1,
        active: true,
        reloadPending: false,
        startedAt: resumeState?.startedAt || Date.now(),
        outputDirTrimmed,
        requestedConcurrency,
        recycleEvery,
        multiPresetCfg,
        totalJobs,
        jobKeys: exportJobKeys,
        nextIndex: Math.max(0, Math.min(totalJobs, Number(resumeState?.nextIndex) || 0)),
        okCount: Math.max(0, Number(resumeState?.okCount) || 0),
        failCount: Math.max(0, Number(resumeState?.failCount) || 0),
        failDetails: Array.isArray(resumeState?.failDetails) ? resumeState.failDetails.slice(-30) : [],
    };
    try { localStorage.setItem(REELS_EXPORT_RESUME_KEY, JSON.stringify(resumeManifest)); } catch (_) { }
    // 并发任务各自上报进度。汇总时必须按每个任务的最新进度相加，
    // 不能用“任务序号 + 当前百分比”，否则回调交错会让总进度条来回跳。
    const jobProgress = new Array(totalJobs).fill(0);
    let lastOverallProgress = 0;
    const updateConcurrentOverallProgress = (jobIndex, pct) => {
        const normalized = Math.max(0, Math.min(100, Number(pct) || 0));
        jobProgress[jobIndex] = Math.max(jobProgress[jobIndex] || 0, normalized);
        const overall = Math.round(jobProgress.reduce((sum, value) => sum + value, 0) / Math.max(1, totalJobs));
        lastOverallProgress = Math.max(lastOverallProgress, overall);
        const progressInner = document.getElementById('reels-export-progress-inner');
        const progressText = document.getElementById('reels-export-progress-text');
        if (progressInner) progressInner.style.width = `${lastOverallProgress}%`;
        if (progressText) progressText.textContent = `${lastOverallProgress}% (${okCount + failCount}/${totalJobs})`;
    };

    // ── 矩阵模式确认 ──
    // 分段重启后是同一批导出的自动续传，不能每 6 条重复询问。
    if (!resumeState && multiPresetCfg && totalJobs > tasks.length) {
        const ok = confirm(`🎭 多模板矩阵导出\n\n${tasks.length} 个任务 × ${multiPresetCfg.presets.length} 个覆层预设 = ${totalJobs} 个视频\n\n已选模板: ${multiPresetCfg.presets.join(', ')}\n命名方式: ${multiPresetCfg.naming === 'folder' ? '按模板分目录' : '平铺命名'}\n\n确认开始导出？`);
        if (!ok) {
            try { localStorage.removeItem(REELS_EXPORT_RESUME_KEY); } catch (_) { }
            if (exportBtn) { exportBtn.disabled = false; exportBtn.innerHTML = '🚀 开始导出'; }
            _reelsState.isExporting = false;
            return;
        }
    }

    _reelsInitJobProgressUI(exportJobs);
    for (let completedIndex = 0; completedIndex < resumeManifest.nextIndex; completedIndex++) {
        jobProgress[completedIndex] = 100;
        _reelsUpdateJobProgressUI(completedIndex, 100, '已完成（续传）', 'success');
    }
    lastOverallProgress = Math.round((resumeManifest.nextIndex / Math.max(1, totalJobs)) * 100);
    _reelsUpdateExportProgressUI(resumeManifest.nextIndex, totalJobs);

    // ═══ 文件名去重：行号 + 冲突检测 ═══
    const _exportResolvedNames = {};
    {
        // 先给每个任务加上行号
        const namedWithRow = exportJobs.map((job, idx) => {
            if (namingMode === 'index') {
                const prefix = localStorage.getItem('reels_naming_prefix') || '';
                const suffixVal = localStorage.getItem('reels_naming_suffix') || '';
                return `${prefix}${idx + 1}${suffixVal}`;
            }
            if (namingMode === 'date-auto') {
                const startDateStr = localStorage.getItem('reels_naming_start_date') || '';
                const vidsPerDay = parseInt(localStorage.getItem('reels_naming_vids_per_day') || '3') || 3;
                const prefix = localStorage.getItem('reels_naming_prefix') || '';
                const suffixVal = localStorage.getItem('reels_naming_suffix') || '';

                let startDate = new Date();
                startDate.setDate(startDate.getDate() + 1);
                if (startDateStr) {
                    const cleanDate = startDateStr.replace(/-/g, '');
                    if (cleanDate.length === 8) {
                        const y = parseInt(cleanDate.substring(0, 4));
                        const m = parseInt(cleanDate.substring(4, 6)) - 1;
                        const d = parseInt(cleanDate.substring(6, 8));
                        startDate = new Date(y, m, d);
                    } else {
                        const parsed = Date.parse(startDateStr);
                        if (!isNaN(parsed)) startDate = new Date(parsed);
                    }
                }
                const dayOffset = Math.floor(idx / vidsPerDay);
                const seq = (idx % vidsPerDay) + 1;
                const targetDate = new Date(startDate.getTime());
                targetDate.setDate(startDate.getDate() + dayOffset);

                const yyyy = targetDate.getFullYear();
                const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
                const dd = String(targetDate.getDate()).padStart(2, '0');
                const dateFormatted = `${yyyy}${mm}${dd}`;

                return `${prefix}${dateFormatted}-${seq}${suffixVal}`;
            }

            const raw = _resolveReelsExportBaseName(job.task, namingMode);
            return `${raw}_行${idx + 1}`;
        });
        // 再检测加完行号后是否仍有重名（极端情况），追加编号
        const freq = {};
        namedWithRow.forEach(n => freq[n] = (freq[n] || 0) + 1);
        const counter = {};
        namedWithRow.forEach((n, idx) => {
            if (freq[n] > 1) {
                counter[n] = (counter[n] || 0) + 1;
                _exportResolvedNames[idx] = `${n}_${counter[n]}`;
            } else {
                _exportResolvedNames[idx] = n;
            }
        });
    }

    failCount = resumeManifest.failCount;
    okCount = resumeManifest.okCount;
    failDetails.splice(0, failDetails.length, ...resumeManifest.failDetails);
    let currentIndex = resumeManifest.nextIndex;
    let contiguousCompletedIndex = resumeManifest.nextIndex;
    const completedOutOfOrder = new Set();
    const segmentedExport = !doFcpxml && recycleEvery > 0 && totalJobs > recycleEvery;
    // 按用户设定的条数正常刷新一次，释放累计的 Canvas/解码资源后自动续传。
    // 刷新前会同步任务、设置和断点；绝不能杀掉 renderer。
    let segmentEnd = segmentedExport
        ? Math.min(totalJobs, resumeManifest.nextIndex + recycleEvery)
        : totalJobs;
    const processNext = async () => {
        while (currentIndex < segmentEnd) {
            if (!_reelsState.isExporting) {
                canceled = true;
                break;
            }
            const i = currentIndex++;
            const job = exportJobs[i];
            // 每个导出 job 都必须拥有独立的任务快照。多模板矩阵会为同一
            // 原任务同时创建多个 job；若直接临时改写 task.overlays，并发导出
            // 时不同模板会互相覆盖，导致成片的字幕/覆层与预览不一致。
            let task = job.task;
            // 与 V2 预览使用同一个渲染计划入口。导出不读取时间线编辑器的
            // 临时显示数据，避免“预览一套、导出另一套”。
            if (window.ReelsRenderPlan?.syncLegacyFields) {
                window.ReelsRenderPlan.syncLegacyFields(task, {
                    width: _reelsState.targetWidth || 1080,
                    height: _reelsState.targetHeight || 1920,
                });
            }
            const tw = _reelsState.targetWidth || 1080;
            const th = _reelsState.targetHeight || 1920;

        const taskStyle = job.subtitleStyle || _resolveSubtitleStyleForTask(task);
        const presetLabel = job.presetName ? ` [${job.presetName}]` : '';

        // ── 确保当前任务的所有覆层与字幕使用的字体全部预加载完成 ──
        _reelsUpdateJobProgressUI(i, 0, '加载字体', 'running');
        if (statusEl) statusEl.textContent = `加载字体中 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel}`;
        if (window.getFontManager) {
            const fm = window.getFontManager();
            const fontsToLoad = fm.collectFonts({
                style: taskStyle,
                segments: task.segments,
                overlays: task.overlays,
                cover: task.cover,
                watermarks: _reelsState.watermarks
            });
            await fm.ensureFontsLoaded(fontsToLoad);
            console.log(`[Export Font Load] Fonts loaded successfully:`, fontsToLoad);
        }

        _reelsUpdateJobProgressUI(i, Math.max(1, jobProgress[i] || 0), '准备导出', 'running');
        if (statusEl) statusEl.textContent = `导出中 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel}`;
        _reelsAppendExportLogUI(`任务 ${i + 1}/${totalJobs}：开始处理 ${task.fileName}${presetLabel}`);
        _reelsAppendExportLogUI(`[绑定核验] ${_summarizeExportBinding(task)}`);

        try {
            let baseName = _exportResolvedNames[i] || _resolveReelsExportBaseName(task, namingMode);

            // ── 多模板矩阵：调整输出路径 ──
            let jobOutputDir = outputDirTrimmed;
            let jobBaseName = baseName;
            if (task._batchTabId) {
                const safeGroupName = String(task._batchTabName || '未命名分组')
                    .replace(/[<>:"/\\|?*]+/g, '_')
                    .replace(/[. ]+$/g, '')
                    .trim() || '未命名分组';
                jobOutputDir = `${jobOutputDir}${outputJoinSep}${safeGroupName}`;
            }
            if (task._folderQueueId) {
                const safeQueueName = String(task._folderQueueName || '文件夹队列')
                    .replace(/[<>:"/\\|?*]+/g, '_')
                    .trim() || '文件夹队列';
                jobOutputDir = `${jobOutputDir}${outputJoinSep}${safeQueueName}`;
            }
            if (job.presetName) {
                const safePresetName = job.presetName.replace(/[<>:"/\\|?*]+/g, '_');
                if (job.naming === 'folder') {
                    // 按模板分目录
                    jobOutputDir = `${jobOutputDir}${outputJoinSep}${safePresetName}`;
                } else {
                    // 平铺命名
                    jobBaseName = `${baseName}_${safePresetName}`;
                }
            }
            const outputPath = `${jobOutputDir}${outputJoinSep}${jobBaseName}${suffix}.mp4`;
            if (window.electronAPI && window.electronAPI.ensureDirectory) {
                const dirResult = await window.electronAPI.ensureDirectory(jobOutputDir);
                if (dirResult && dirResult.ok === false) {
                    throw new Error(`创建输出目录失败: ${dirResult.error || jobOutputDir}`);
                }
            }
            let bgPath = _resolveTaskExportBackgroundPath(task);
            // 绝不能跨任务按文件名猜素材。多个账号/文件夹常出现同名视频，
            // 猜错后成片看起来就像“视频 A 配了任务 B 的字幕和覆层”。
            if (bgPath && !_isAbsoluteReelsMediaPath(bgPath)) {
                throw new Error(`任务「${task.fileName || task.baseName || i + 1}」的背景素材缺少完整本地路径：${bgPath}。请重新选择该视频后再导出；为防止串用其他任务的同名素材，本次已停止。`);
            }
            
            const hasVoiceAudio = !!task.audioPath || workMode === 'voiced_bg';
            // For voiced_bg mode, use the background video's audio track as the voice source
            const voiceSource = task.audioPath || (workMode === 'voiced_bg' ? bgPath : null);
            const effectiveAudioDurScale = (workMode === 'voiced_bg' && !task.audioPath)
                ? (task.bgDurScale || task.audioDurScale || 100)
                : (task.audioDurScale || 100);
            let finalOutputPath = outputPath;

            // ── 读取导出格式 ──
            const exportFormat = (document.getElementById('reels-export-format') || {}).value || 'mp4';
            const doPng = exportFormat === 'png-layers' || exportFormat === 'mp4+png';
            const doMp4 = exportFormat === 'mp4' || exportFormat === 'mp4+png';
            const doFcpxml = exportFormat === 'fcpxml' || exportFormat === 'fcpxml-compound';

            // Validate task audio before rendering hundreds of frames. Saved
            // projects may still contain absolute paths to files that were
            // moved or deleted after the project was created.
            if (window.electronAPI && typeof window.electronAPI.checkFilesExist === 'function') {
                const effectiveBgmPath = _getEffectiveBgmVolumePercent(task, bgmVolume) > 0
                    ? (_getEffectiveBgmPath(task, i) || '')
                    : '';
                const pathsToCheck = [voiceSource, effectiveBgmPath].filter(Boolean);
                if (pathsToCheck.length > 0) {
                    const existsMap = await window.electronAPI.checkFilesExist(pathsToCheck);
                    if (voiceSource && !existsMap[voiceSource]) {
                        throw new Error(`配音文件不存在，请重新选择或生成配音：${voiceSource}`);
                    }
                    if (effectiveBgmPath && !existsMap[effectiveBgmPath]) {
                        throw new Error(`背景音乐文件不存在，请重新选择：${effectiveBgmPath}`);
                    }
                }
            }
            
            const subtitleToggle = document.getElementById('reels-subtitle-toggle');
            const showSubtitle = !subtitleToggle || subtitleToggle.checked;
            const showOverlay = _isReelsOverlayToggleEnabled();

            // ── 封面静帧单独输出 ──
            if (task.cover && task.cover.enabled !== false && task.cover.exportSeparate !== false) {
                 await _exportSaveCoverPng(task, jobOutputDir, jobBaseName);
            }

            // ── 封面视频拼接输出 ──
            let coverMp4Path = null;
            if (task.cover && task.cover.enabled !== false && doMp4 && parseFloat(task.cover.duration || 0) > 0) {
                 coverMp4Path = await _exportCoverVideo(task, taskStyle, jobOutputDir, jobBaseName);
            }

            // ═══ PNG 分层序列导出 ═══
            if (doPng && typeof window.reelsLayeredExport === 'function') {
                const tw = _reelsState.targetWidth || 1080;
                const th = _reelsState.targetHeight || 1920;
                const offCanvas = document.createElement('canvas');
                offCanvas.width = tw;
                offCanvas.height = th;

                const layeredResult = await window.reelsLayeredExport({
                    canvas: offCanvas,
                    style: taskStyle,
                    segments: task.segments || [],
                    originalScript: task.ttsText || task.aiScript || task.txtContent || "",
                    showSubtitle: showSubtitle,
                    overlays: _getTaskRenderOverlays(task, { showOverlay }),
                    insertAudioClips: _getTaskInsertAudio(task),
                    overlayAboveSubtitle: task.overlayAboveSubtitle !== false,
                    backgroundPath: bgPath,
                    bgMode: task.bgMode || 'single',
                    bgClipPool: _getEffectiveBgClipPool(task),
                    bgClipSettings: task.bgClipSettings || {},
                    bgMinClipDur: task.bgMinClipDur !== undefined ? task.bgMinClipDur : 5,
                    bgMaxClipDur: task.bgMaxClipDur !== undefined ? task.bgMaxClipDur : 7,
                    bgClipOrder: task.bgClipOrder || 'random',
                    bgClipSeed: task.id || task.fileName || '',
                    bgTransition: task.bgTransition || 'crossfade',
                    bgTransDur: task.bgTransDur || 0.5,
                    contentVideoPath: task.contentVideoPath || null,
                    contentVideoTrimStart: task.contentVideoTrimStart != null ? task.contentVideoTrimStart : null,
                    contentVideoTrimEnd: task.contentVideoTrimEnd != null ? task.contentVideoTrimEnd : null,
                    contentVideoScale: task.contentVideoScale || 100,
                    contentVideoX: task.contentVideoX || 'center',
                    contentVideoY: task.contentVideoY || 'center',
                    contentVideoVolume: (task.contentVideoVolume != null ? task.contentVideoVolume : 100) / 100,
                    contentVideoCrop: task.contentVideoCrop || '',
                    contentVideoBlurBg: task.contentVideoBlurBg || false,
                    contentVideoDirectBg: task.contentVideoDirectBg || false,
                    contentVideoBlur: task.contentVideoBlur != null ? task.contentVideoBlur : 40,
                    contentVideoBrightness: task.contentVideoBrightness != null ? task.contentVideoBrightness : 60,
                    voicePath: voiceSource || null,
                    outputDir: jobOutputDir,
                    taskName: jobBaseName,
                    targetWidth: tw,
                    targetHeight: th,
                    fps: 30,

                    voiceVolume: (workMode === 'voiced_bg' && !task.audioPath) ? _getEffectiveBgVolumePercent(task, bgVolume) / 100 : _getEffectiveVoiceVolumePercent(task, voiceVolume) / 100,
                    bgVolume: _getEffectiveBgVolumePercent(task, bgVolume) / 100,
                    loopFade,
                    loopFadeDur,
                    customDuration: resolveReelsCustomDuration(task, customDuration),
                    bgmPath: _getEffectiveBgmPath(task, i) || '',
                    bgmVolume: _getEffectiveBgmVolumePercent(task, bgmVolume) / 100,
                    bgmStart: Math.max(0, parseFloat(task.bgmStart) || 0),
                    bgScale: task.bgScale || 100,
                    bgRotation: task.bgRotation || 0,
                    bgX: task.bgX || 0,
                    bgY: task.bgY || 0,
                    bgFlipH: task.bgFlipH || false,
                    bgFlipV: task.bgFlipV || false,
                    contentVideoFlipH: task.contentVideoFlipH || false,
                    contentVideoFlipV: task.contentVideoFlipV || false,
                    bgDurScale: task.bgDurScale || 100,
                    audioDurScale: task.audioDurScale || 100,
                    isCancelled: () => !_reelsState.isExporting,
                    onProgress: (pct) => {
                        if (statusEl) statusEl.textContent = `分层导出 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel} (${pct}%)`;
                        _reelsUpdateJobProgressUI(i, pct, '分层导出', 'running');
                        updateConcurrentOverallProgress(i, pct);
                    },
                    onLog: (msg) => {
                        console.log(`[Layered] ${task.fileName}: ${msg}`);
                        _reelsAppendExportLogUI(`${task.fileName}：${msg}`);
                    },
                });
                if (layeredResult && layeredResult.cancelled) {
                    canceled = true;
                    _reelsUpdateJobProgressUI(i, jobProgress[i], '已取消', 'canceled');
                    break;
                }
                finalOutputPath = layeredResult?.layersDir || jobOutputDir;
            }

            // ═══ FCPXML 导出收集 ═══
            if (doFcpxml) {
                // ── 渲染覆层为透明 PNG ──
                let overlayPngPath = null;
                let overlayPngSlices = null; // 时间切片多 PNG 模式
                const taskOverlays = showOverlay ? (task.overlays || []) : [];
                let hasTimeSlice = task.subtitleTimeMode === 'split' && Array.isArray(task.subtitleTimeSlices) && task.subtitleTimeSlices.length > 0;

                // B 版自动拆分：标题 0~10s，正文 10s~ (通过 AB 批量创建时的 _version 标记识别)
                const isBVersion = task._version === 'B';
                // B 版强制覆盖切片: 已有切片可能是旧数据(source 为 'all')，强制替换为 title/body
                const needsBSlice = isBVersion && taskOverlays.some(o => !o.disabled && (o.type === 'textcard' || !o.type));
                if (needsBSlice) {
                    const bOverlaySplit = 10;
                    task.subtitleTimeSlices = [
                        { label: '标题', source: 'title', startSec: 0, endSec: bOverlaySplit },
                        { label: '正文', source: 'body', startSec: bOverlaySplit, endSec: null },
                    ];
                    task.subtitleTimeMode = 'split';
                    hasTimeSlice = true;
                }

                if (taskOverlays.length > 0 && taskOverlays.some(o => !o.disabled)) {
                    const tw = _reelsState.targetWidth || 1080;
                    const th = _reelsState.targetHeight || 1920;
                    if (hasTimeSlice) {
                        // ⏱️ 时间切片模式：为每个切片生成独立的 PNG
                        overlayPngSlices = [];
                        for (let sliceIdx = 0; sliceIdx < task.subtitleTimeSlices.length; sliceIdx++) {
                            const slice = task.subtitleTimeSlices[sliceIdx];
                            const source = slice.source || 'all';
                            try {
                                const offCanvas = document.createElement('canvas');
                                offCanvas.width = tw;
                                offCanvas.height = th;
                                const offCtx = offCanvas.getContext('2d');
                                offCtx.clearRect(0, 0, tw, th);
                                if (window.ReelsOverlay && typeof window.ReelsOverlay.drawOverlay === 'function') {
                                    // ── 时间切片渲染: 整体控制所有覆层的文字字段 ──
                                    // 保存所有覆层的原始文字字段
                                    const savedFields = taskOverlays.map(ov => ({
                                        title_text: ov.title_text,
                                        body_text: ov.body_text,
                                        footer_text: ov.footer_text,
                                        content: ov.content,
                                        disabled: ov.disabled,
                                    }));

                                    try {
                                        for (const ov of taskOverlays) {
                                            const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                            if (isCard) {
                                                ov._original_title_text = ov.title_text;
                                                ov._original_body_text = ov.body_text;
                                                ov._original_footer_text = ov.footer_text;
                                            }
                                            ov._fcpxml_generating = true;
                                        }

                                        if (source === 'title') {
                                            // 标题模式: 只保留第一个有 title_text 的 textcard 的标题，纯色蒙版作为背景保留
                                            for (const ov of taskOverlays) {
                                                const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                                const isSolidMask = ov.type === 'solid_mask';
                                                if (isCard) {
                                                    ov.body_text = '';
                                                    ov.footer_text = '';
                                                    if (!ov.title_text) ov.disabled = true;
                                                } else if (isSolidMask) {
                                                    // 保持纯色蒙版启用
                                                } else {
                                                    ov.disabled = true; // 标题模式不渲染非卡片覆层
                                                }
                                            }
                                        } else if (source === 'body') {
                                            // 正文模式: 清空所有 textcard 的标题, 保留正文+结尾+其他覆层
                                            for (const ov of taskOverlays) {
                                                const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                                if (isCard) {
                                                    ov.title_text = '';
                                                }
                                            }
                                        } else if (source === 'body_part1') {
                                            for (const ov of taskOverlays) {
                                                const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                                if (isCard && ov.body_text) {
                                                    ov.body_text = window.ReelsOverlay?.splitBodyText ? window.ReelsOverlay.splitBodyText(ov.body_text)[0] : ov.body_text;
                                                }
                                            }
                                        } else if (source === 'body_part2') {
                                            for (const ov of taskOverlays) {
                                                const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                                if (isCard && ov.body_text) {
                                                    ov.body_text = window.ReelsOverlay?.splitBodyText ? window.ReelsOverlay.splitBodyText(ov.body_text)[1] : ov.body_text;
                                                }
                                            }
                                        } else if (source === 'footer') {
                                            for (const ov of taskOverlays) {
                                                const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                                if (isCard) { ov.title_text = ''; ov.body_text = ''; }
                                            }
                                        }
                                        // scroll source 类型保持不变

                                        // 统一渲染所有未禁用的覆层
                                        for (const ov of taskOverlays) {
                                            if (ov.disabled) continue;
                                            if (source === 'scroll_title' && ov.type !== 'scroll') continue;
                                            if (source === 'scroll_body' && ov.type !== 'scroll') continue;
                                            ov._exporting = true;
                                            window.ReelsOverlay.drawOverlay(offCtx, ov, 0, tw, th);
                                            delete ov._exporting;
                                        }
                                    } finally {
                                        // 恢复所有覆层的原始字段
                                        taskOverlays.forEach((ov, idx) => {
                                            ov.title_text = savedFields[idx].title_text;
                                            ov.body_text = savedFields[idx].body_text;
                                            ov.footer_text = savedFields[idx].footer_text;
                                            ov.content = savedFields[idx].content;
                                            ov.disabled = savedFields[idx].disabled;
                                            delete ov._original_title_text;
                                            delete ov._original_body_text;
                                            delete ov._original_footer_text;
                                            delete ov._fcpxml_generating;
                                        });
                                    }
                                }
                                const pngDataUrl = offCanvas.toDataURL('image/png');
                                const pngBase64 = pngDataUrl.replace(/^data:image\/png;base64,/, '');
                                const binaryStr = atob(pngBase64);
                                const pngBytes = new Uint8Array(binaryStr.length);
                                for (let b = 0; b < binaryStr.length; b++) pngBytes[b] = binaryStr.charCodeAt(b);

                                const sliceLabel = slice.label || String.fromCharCode(65 + sliceIdx);
                                const pngFileName = `${jobBaseName}_overlay_${sliceLabel}.png`;
                                const pngPath = `${jobOutputDir}/${pngFileName}`;
                                if (window.electronAPI && window.electronAPI.ensureDirectory) {
                                    await window.electronAPI.ensureDirectory(jobOutputDir);
                                }
                                if (window.electronAPI && window.electronAPI.savePngFrame) {
                                    const saveResult = await window.electronAPI.savePngFrame({
                                        outputPath: pngPath,
                                        rawRGBA: pngBytes.buffer,
                                        width: tw,
                                        height: th,
                                        isPng: true
                                    });
                                    if (saveResult && saveResult.ok) {
                                        overlayPngSlices.push({
                                            path: pngPath,
                                            startSec: slice.startSec || 0,
                                            endSec: slice.endSec,
                                            label: sliceLabel,
                                        });
                                        console.log(`[FCPXML] 切片 ${sliceLabel} PNG 已导出: ${pngPath}`);
                                    }
                                }
                            } catch (e) {
                                console.warn(`[FCPXML] 渲染切片 ${sliceIdx} PNG 失败:`, e);
                            }
                        }
                    } else {
                        // 常规模式：单张 PNG
                    try {
                        const offCanvas = document.createElement('canvas');
                        offCanvas.width = tw;
                        offCanvas.height = th;
                        const offCtx = offCanvas.getContext('2d');
                        offCtx.clearRect(0, 0, tw, th);
                        if (window.ReelsOverlay && typeof window.ReelsOverlay.drawOverlay === 'function') {
                            for (const ov of taskOverlays) {
                                if (ov.disabled) continue;
                                ov._exporting = true;
                                window.ReelsOverlay.drawOverlay(offCtx, ov, 0, tw, th);
                                delete ov._exporting;
                            }
                        }
                        const pngDataUrl = offCanvas.toDataURL('image/png');
                        const pngBase64 = pngDataUrl.replace(/^data:image\/png;base64,/, '');
                        const binaryStr = atob(pngBase64);
                        const pngBytes = new Uint8Array(binaryStr.length);
                        for (let b = 0; b < binaryStr.length; b++) pngBytes[b] = binaryStr.charCodeAt(b);

                        const pngFileName = `${jobBaseName}_overlay.png`;
                        const pngPath = `${jobOutputDir}/${pngFileName}`;
                        if (window.electronAPI && window.electronAPI.ensureDirectory) {
                            await window.electronAPI.ensureDirectory(jobOutputDir);
                        }
                        if (window.electronAPI && window.electronAPI.savePngFrame) {
                            const saveResult = await window.electronAPI.savePngFrame({
                                outputPath: pngPath,
                                rawRGBA: pngBytes.buffer,
                                width: tw,
                                height: th,
                                isPng: true
                            });
                            if (saveResult && saveResult.ok) {
                                overlayPngPath = pngPath;
                                console.log(`[FCPXML] 覆层 PNG 已导出: ${pngPath}`);
                            } else {
                                console.warn('[FCPXML] 覆层 PNG 保存失败:', saveResult?.error);
                            }
                        }
                    } catch (e) {
                        console.warn('[FCPXML] 渲染覆层 PNG 失败:', e);
                    }
                    }
                }

                fcpxmlBatchTasks.push({
                    task,
                    style: taskStyle,
                    segments: showSubtitle ? (task.segments || []) : [],
                    overlays: taskOverlays,
                    overlayPngPath: overlayPngPath,  // 单张 PNG（常规模式）
                    overlayPngSlices: overlayPngSlices, // 多张 PNG（时间切片模式）
                    videoPath: task.videoPath || null,
                    backgroundPath: bgPath,
                    contentVideoPath: task.contentVideoPath || null,
                    contentVideoTrimStart: task.contentVideoTrimStart != null ? task.contentVideoTrimStart : null,
                    contentVideoTrimEnd: task.contentVideoTrimEnd != null ? task.contentVideoTrimEnd : null,
                    voicePath: voiceSource || null,
                    bgmPath: _getEffectiveBgmPath(task, i) || '',
                    customDuration: resolveReelsCustomDuration(task, customDuration),
                    taskName: baseName,
                    subtitleTimeMode: task.subtitleTimeMode || 'full',
                    subtitleTimeSlices: task.subtitleTimeSlices || [],
                });
                okCount += 1;
                // 更新进度并进入下一个
                if (statusEl) statusEl.textContent = `FCPXML整理数据 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel}`;
                _reelsUpdateJobFastCapabilityUI(i, 'none', 'FCPXML 不进行视频编码');
                _reelsUpdateJobProgressUI(i, 100, '整理完成', 'success');
                updateConcurrentOverallProgress(i, 100);
                continue;
            }

            // ═══ MP4 视频导出（WYSIWYG）═══
            if (doMp4 && (typeof window.reelsWysiwygExport === 'function')
                && window.electronAPI && window.electronAPI.reelsComposeWysiwyg) {
                // 创建离屏 canvas
                const tw = _reelsState.targetWidth || 1080;
                const th = _reelsState.targetHeight || 1920;
                const offCanvas = document.createElement('canvas');
                offCanvas.width = tw;
                offCanvas.height = th;

                // ═══ V3 并行影子窗口检测 ═══
                const cpuCores = navigator.hardwareConcurrency || 4;
                const parallelConcurrency = Math.min(3, Math.max(1, Math.floor(cpuCores / 2)));
                let estimatedDuration = 0;
                try {
                    let maxFlipperDuration = 0;
                    if (showOverlay && task && Array.isArray(task.overlays)) {
                        for (const ov of task.overlays) {
                            if (ov && !ov.disabled && ov.flipper_enabled) {
                                const text = (ov.type === 'textcard') ? (ov.body_text || '') : (ov.content || '');
                                const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                                const flipper_lines = parseInt(ov.flipper_lines) || 2;
                                const flipper_duration = parseFloat(ov.flipper_duration) || 2.0;
                                const totalChunks = Math.ceil(lines.length / flipper_lines);
                                const flipperDur = (parseFloat(ov.start) || 0) + (totalChunks * flipper_duration);
                                if (flipperDur > maxFlipperDuration) {
                                    maxFlipperDuration = flipperDur;
                                }
                            }
                        }
                    }
                    if (maxFlipperDuration > 0) {
                        estimatedDuration = maxFlipperDuration;
                    } else if (task.customDuration > 0) {
                        estimatedDuration = task.customDuration;
                    } else if ((task.audioPath || voiceSource) && window.electronAPI.getMediaDuration) {
                        estimatedDuration = await window.electronAPI.getMediaDuration(task.audioPath || voiceSource);
                    }
                    if (!estimatedDuration) {
                        if (task.contentVideoDirectBg && task.contentVideoPath) {
                            let cvDur = await window.electronAPI.getMediaDuration(task.contentVideoPath);
                            if (cvDur > 0) {
                                const trimS = task.contentVideoTrimStart != null ? parseFloat(task.contentVideoTrimStart) : 0;
                                const trimE = task.contentVideoTrimEnd != null ? parseFloat(task.contentVideoTrimEnd) : 0;
                                if (trimE > trimS) {
                                    cvDur = trimE - trimS;
                                } else if (trimS > 0) {
                                    cvDur = Math.max(0, cvDur - trimS);
                                }
                                estimatedDuration = cvDur;
                            }
                        } else if (bgPath) {
                            estimatedDuration = await window.electronAPI.getMediaDuration(bgPath);
                        }
                    }
                } catch(_) {}
                // 媒体探测失败可能返回 null/undefined，任务自定义时长也可能是字符串。
                // 后续日志和并行判断都要求有限数字；无效值归零，由稳定导出路径自行探测/兜底。
                estimatedDuration = Number(estimatedDuration);
                if (!Number.isFinite(estimatedDuration) || estimatedDuration < 0) estimatedDuration = 0;
                const estimatedFrames = Math.ceil((estimatedDuration || 0) * 30);
                const hasVideoOverlays = showOverlay && Array.isArray(task.overlays) && task.overlays.some(ov => ov && ov.type === 'video' && !ov.disabled);
                const hasContentVideo = !!task.contentVideoPath;
                let contentVideoIsDirSequence = false;
                const cvPathForCheck = _normalizeLocalMediaPath(task.contentVideoPath || '');
                if (cvPathForCheck && window.require) {
                    try {
                        const fs = window.require('fs');
                        contentVideoIsDirSequence = fs.existsSync(cvPathForCheck) && fs.statSync(cvPathForCheck).isDirectory();
                    } catch (_) { }
                }
                // 并行影子窗口在视频逐帧 seek 尚未完成时可能写入上一帧，成片会出现跳帧/抖动。
                // 在有可靠的逐帧解码同步方案前，绝不能将它用于正式导出；保留实现供后续修复验证，
                // 默认始终走已验证的单线程逐帧导出路径，优先保证帧完整和时间连续。
                const parallelExportEnabled = false;
                const shouldParallel = parallelExportEnabled
                    && memoryDecoderEnabled
                    // 任务级并发时已经会并行。影子窗口切片使用全局 IPC 事件，
                    // 为防止两个任务的同编号切片互相串结果，仅在单任务导出时开启切片并行。
                    && concurrency === 1
                    && parallelConcurrency >= 2
                    && estimatedDuration >= 10
                    && _getEffectiveBgClipPool(task).length === 0
                    && !hasVideoOverlays
                    && !hasContentVideo
                    && !contentVideoIsDirSequence
                    && window.electronAPI.parallelWysiwygExport;

                let wysiwygDone = false;
                if (shouldParallel) {
                    console.log(`[V3] 启动并行渲染: ${parallelConcurrency} 路, ${estimatedDuration.toFixed(1)}s, ${estimatedFrames} 帧`);
                    if (statusEl) statusEl.textContent = `🚀并行导出 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel} (启动中...)`;
                    const unsubProgress = window.electronAPI.onParallelProgress((data) => {
                        if (statusEl) statusEl.textContent = `🚀并行导出 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel} (${data.pct || 0}%)`;
                    });
                    try {
                        const parallelResult = await window.electronAPI.parallelWysiwygExport({
                            params: {
                                style: taskStyle,
                                segments: showSubtitle ? (task.segments || []) : [],
                                overlays: _getTaskRenderOverlays(task),
                                backgroundPath: bgPath,
                                bgMode: task.bgMode || 'single',
                                bgScale: task.bgScale || 100,
                                bgRotation: task.bgRotation || 0,
                                bgX: task.bgX || 0,
                                bgY: task.bgY || 0,
                                contentVideoPath: task.contentVideoPath || null,
                                contentVideoTrimStart: task.contentVideoTrimStart,
                                contentVideoTrimEnd: task.contentVideoTrimEnd,
                                contentVideoScale: task.contentVideoScale || 100,
                                contentVideoX: task.contentVideoX || 'center',
                                contentVideoY: task.contentVideoY || 'center',
                                contentVideoVolume: (task.contentVideoVolume != null ? task.contentVideoVolume : 100) / 100,
                                contentVideoCrop: task.contentVideoCrop || '',
                                contentVideoBlurBg: task.contentVideoBlurBg || false,
                                contentVideoDirectBg: task.contentVideoDirectBg || false,
                                contentVideoBlur: task.contentVideoBlur != null ? task.contentVideoBlur : 40,
                                contentVideoBrightness: task.contentVideoBrightness != null ? task.contentVideoBrightness : 60,
                                voicePath: voiceSource || null,
                                targetWidth: tw, targetHeight: th, fps: 30,
                                voiceVolume: (workMode === 'voiced_bg' && !task.audioPath) ? _getEffectiveBgVolumePercent(task, bgVolume) / 100 : _getEffectiveVoiceVolumePercent(task, voiceVolume) / 100,
                                bgVolume: _getEffectiveBgVolumePercent(task, bgVolume) / 100,
                                loopFade, loopFadeDur,
                                bgmPath: _getEffectiveBgmPath(task, i) || '',
                                bgmVolume: _getEffectiveBgmVolumePercent(task, bgmVolume) / 100,
                                bgmStart: Math.max(0, parseFloat(task.bgmStart) || 0),
                                bgDurScale: task.bgDurScale || 100,
                                audioDurScale: effectiveAudioDurScale,
                                reverbEnabled: _getReverbConfig().enabled,
                                reverbPreset: _getReverbConfig().preset,
                                reverbMix: _getReverbConfig().mix,
                                stereoWidth: _getReverbConfig().stereoWidth,
                                audioFxTarget: _getReverbConfig().audioFxTarget,
                                bgHasAudio: bgPath && !_isImageFile(bgPath) && !(voiceSource && voiceSource === bgPath),
                                qualityPreset, crf, targetBitrateMbps, maxBitrateMbps,
                            },
                            outputPath,
                            concurrency: parallelConcurrency,
                            totalFrames: estimatedFrames,
                            duration: estimatedDuration,
                        });
                        unsubProgress();
                        if (!parallelResult || parallelResult.error) throw new Error(parallelResult?.error || '并行导出失败');
                        console.log(`[V3] 并行导出成功: ${parallelResult.output_path}`);
                        wysiwygDone = true;
                    } catch (parallelErr) {
                        unsubProgress();
                        console.warn(`[V3] 并行导出失败，回退单线程: ${parallelErr.message}`);
                    }
                } else if (memoryDecoderEnabled) {
                    console.log(`[V3] 跳过切片并行，回退稳定渲染: enabled=${parallelExportEnabled}, taskConcurrency=${concurrency}, duration=${estimatedDuration.toFixed(1)}, overlayVideo=${hasVideoOverlays}, contentVideo=${hasContentVideo}, contentDirSeq=${contentVideoIsDirSequence}`);
                }

                // ═══ Fast Alpha Overlay 检测 ═══
                const fastAlphaCb = document.getElementById('reels-fast-alpha-mode');
                // 流水线/硬件模式自动尝试背景直通；不再要求用户另外勾选“极速贴合”。
                // 不兼容的多背景、时长变速仍会安全回退完整 Canvas。
                const fastEngineEnabled = exportEngine === 'pipeline' || exportEngine === 'hardware';
                const fastAlphaEnabled = fastEngineEnabled || (fastAlphaCb ? fastAlphaCb.checked : false);
                const fastCapability = _getReelsFastExportCapability(task, bgPath);
                const canUseAlpha = fastAlphaEnabled && fastCapability.supported;
                const capabilityDisplay = _describeReelsFastCapability(
                    fastCapability,
                    fastAlphaEnabled,
                    fastEngineEnabled,
                );
                _reelsUpdateJobFastCapabilityUI(i, capabilityDisplay.kind, capabilityDisplay.reason);

                // ═══ V2 单线程 WYSIWYG 导出（兜底 / 常规路径）═══
                if (!wysiwygDone) {
                const reportWysiwygProgress = (pct) => {
                    if (statusEl) statusEl.textContent = `导出中 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel} (${pct}%)`;
                    const stage = pct < 20 ? '准备素材' : (pct < 88 ? '渲染画面' : '编码混音');
                    _reelsUpdateJobProgressUI(i, pct, stage, 'running');
                    updateConcurrentOverallProgress(i, pct);
                };
                const wysiwygParams = {
                    canvas: offCanvas,
                    style: taskStyle,
                    segments: task.segments || [],
                    originalScript: task.ttsText || task.aiScript || task.txtContent || "",
                    showSubtitle: showSubtitle,
                    overlays: _getTaskRenderOverlays(task),
                    insertAudioClips: _getTaskInsertAudio(task),
                    // 必须把任务实际层级传进 WYSIWYG 导出。缺失时导出函数会使用
                    // 默认 true，造成“预览覆层在字幕下，导出却跑到字幕上”的不一致。
                    overlayAboveSubtitle: task.overlayAboveSubtitle !== false,
                    backgroundPath: bgPath,
                    alphaOverlayBgPath: canUseAlpha ? bgPath : null,
                    bgMode: task.bgMode || 'single',
                    bgClipPool: _getEffectiveBgClipPool(task),
                    bgClipSettings: task.bgClipSettings || {},
                    bgMinClipDur: task.bgMinClipDur !== undefined ? task.bgMinClipDur : 5,
                    bgMaxClipDur: task.bgMaxClipDur !== undefined ? task.bgMaxClipDur : 7,
                    bgClipOrder: task.bgClipOrder || 'random',
                    bgClipSeed: task.id || task.fileName || '',
                    bgTransition: task.bgTransition || 'crossfade',
                    bgTransDur: task.bgTransDur || 0.5,
                    contentVideoPath: task.contentVideoPath || null,
                    contentVideoTrimStart: task.contentVideoTrimStart != null ? task.contentVideoTrimStart : null,
                    contentVideoTrimEnd: task.contentVideoTrimEnd != null ? task.contentVideoTrimEnd : null,
                    contentVideoScale: task.contentVideoScale || 100,
                    contentVideoX: task.contentVideoX || 'center',
                    contentVideoY: task.contentVideoY || 'center',
                    contentVideoVolume: (task.contentVideoVolume != null ? task.contentVideoVolume : 100) / 100,
                    contentVideoCrop: task.contentVideoCrop || '',
                    contentVideoBlurBg: task.contentVideoBlurBg || false,
                    contentVideoDirectBg: task.contentVideoDirectBg || false,
                    contentVideoBlur: task.contentVideoBlur != null ? task.contentVideoBlur : 40,
                    contentVideoBrightness: task.contentVideoBrightness != null ? task.contentVideoBrightness : 60,
                    voicePath: voiceSource || null,
                    outputPath,
                    targetWidth: tw,
                    targetHeight: th,
                    fps: 30,
                    // voiced_bg 模式: 背景音频作为主音轨，用 bgVolume 控制
                    voiceVolume: (workMode === 'voiced_bg' && !task.audioPath) ? _getEffectiveBgVolumePercent(task, bgVolume) / 100 : _getEffectiveVoiceVolumePercent(task, voiceVolume) / 100,
                    bgVolume: _getEffectiveBgVolumePercent(task, bgVolume) / 100,
                    loopFade,
                    loopFadeDur,
                    customDuration: resolveReelsCustomDuration(task, customDuration),
                    bgmPath: _getEffectiveBgmPath(task, i) || '',
                    bgmVolume: _getEffectiveBgmVolumePercent(task, bgmVolume) / 100,
                    bgmStart: Math.max(0, parseFloat(task.bgmStart) || 0),
                    bgScale: task.bgScale || 100,
                    bgRotation: task.bgRotation || 0,
                    bgX: task.bgX || 0,
                    bgY: task.bgY || 0,
                    bgFlipH: task.bgFlipH || false,
                    bgFlipV: task.bgFlipV || false,
                    contentVideoFlipH: task.contentVideoFlipH || false,
                    contentVideoFlipV: task.contentVideoFlipV || false,
                    bgDurScale: task.bgDurScale || 100,
                    audioDurScale: effectiveAudioDurScale,
                    reverbEnabled: (() => { const rc = _getReverbConfig(); console.log('[Export] Reverb config:', JSON.stringify(rc)); return rc.enabled; })(),
                    reverbPreset: _getReverbConfig().preset,
                    reverbMix: _getReverbConfig().mix,
                    stereoWidth: _getReverbConfig().stereoWidth,
                    audioFxTarget: _getReverbConfig().audioFxTarget,
                    useMemoryDecoder: memoryDecoderEnabled,
                    useGPU: gpuEnabled || exportEngine === 'hardware',
                    crf,
                    qualityPreset,
                    targetBitrateMbps,
                    maxBitrateMbps,
                    exportEngine,
                    isCancelled: () => !_reelsState.isExporting,
                    watermarks: _reelsState.watermarks || [],
                    onProgress: reportWysiwygProgress,
                    onLog: (msg) => {
                        console.log(`[WYSIWYG] ${task.fileName}: ${msg}`);
                        _reelsAppendExportLogUI(`${task.fileName}：${msg}`);
                    },
                };
                let wysiwygResult;
                if (window.electronAPI?.isolatedWysiwygExport) {
                    const isolatedParams = _cloneProjectDataForSave(wysiwygParams);
                    delete isolatedParams.canvas;
                    const runIsolatedOnce = async (attempt) => {
                        const requestId = `reels-job-${Date.now()}-${i}-${attempt}-${Math.random().toString(36).slice(2, 8)}`;
                        const unsubscribe = window.electronAPI.onIsolatedWysiwygProgress(
                            requestId,
                            data => reportWysiwygProgress(Number(data.pct) || 0),
                        );
                        const cancelTimer = setInterval(() => {
                            if (!_reelsState.isExporting) window.electronAPI.cancelIsolatedWysiwygExport(requestId);
                        }, 250);
                        try {
                        // Canvas 与回调不能跨进程；其余任务数据先移除 DOM/运行时缓存再发送。
                            return await window.electronAPI.isolatedWysiwygExport({ requestId, params: isolatedParams });
                        } finally {
                            clearInterval(cancelTimer);
                            unsubscribe();
                        }
                    };
                    try {
                        wysiwygResult = await runIsolatedOnce(1);
                    } catch (error) {
                        if (!_reelsState.isExporting || !/后台渲染进程异常退出/.test(String(error?.message || error))) throw error;
                        console.warn(`[Reels] 后台渲染器异常退出，自动重试一次: ${task.fileName}`);
                        if (statusEl) statusEl.textContent = `后台渲染器已恢复，正在重试 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel}`;
                        await new Promise(resolve => setTimeout(resolve, 800));
                        wysiwygResult = await runIsolatedOnce(2);
                    }
                } else {
                    wysiwygResult = await window.reelsWysiwygExport(wysiwygParams);
                }
                if (wysiwygResult && wysiwygResult.cancelled) {
                    canceled = true;
                    _reelsUpdateJobProgressUI(i, jobProgress[i], '已取消', 'canceled');
                    break;
                }
                } // end if (!wysiwygDone)
            } else if (hasVoiceAudio && voiceSource) {
                // ── 回退: ASS 字幕方式导出（需要配音）──
                _reelsUpdateJobFastCapabilityUI(i, 'unsupported', '当前任务使用 ASS 稳定导出链路');
                const aDurScale = task.audioDurScale || 100;
                const factor = aDurScale / 100;
                const scaledSegments = (factor !== 1.0 && task.segments) 
                    ? task.segments.map(s => ({ ...s, start: s.start * factor, end: s.end * factor, words: s.words ? s.words.map(w => ({...w, start: w.start * factor, end: w.end * factor})) : undefined }))
                    : task.segments;

                const assContent = window.ReelsSubtitleProcessor
                    ? ReelsSubtitleProcessor.generateEnhancedASS(scaledSegments, taskStyle, {
                        karaokeHighlight: karaokeHL,
                        videoW: tw,
                        videoH: th,
                    })
                    : generateASS(task.segments, taskStyle);

                const resp = await _reelsComposeViaBackend({
                    background_path: bgPath,
                    voice_path: voiceSource,
                    ass_content: assContent,
                    output_path: outputPath,
                    crf,
                    use_gpu: gpuEnabled,
                    loop_fade: loopFade,
                    loop_fade_dur: loopFadeDur,
                    voice_volume: _getEffectiveVoiceVolumePercent(task, voiceVolume) / 100,
                    bg_volume: _getEffectiveBgVolumePercent(task, bgVolume) / 100,
                    bgm_path: _getEffectiveBgmPath(task, i) || '',
                    bgm_volume: _getEffectiveBgmVolumePercent(task, bgmVolume) / 100,
                    bgm_start: Math.max(0, parseFloat(task.bgmStart) || 0),
                });
            } else if (window.electronAPI && window.electronAPI.burnSubtitles) {
                _reelsUpdateJobFastCapabilityUI(i, 'unsupported', '当前任务使用字幕烧录稳定链路');
                const aDurScale = task.audioDurScale || 100;
                const factor = aDurScale / 100;
                const scaledSegments = (factor !== 1.0 && task.segments) 
                    ? task.segments.map(s => ({ ...s, start: s.start * factor, end: s.end * factor, words: s.words ? s.words.map(w => ({...w, start: w.start * factor, end: w.end * factor})) : undefined }))
                    : task.segments;

                const assContent = window.ReelsSubtitleProcessor
                    ? ReelsSubtitleProcessor.generateEnhancedASS(scaledSegments, taskStyle, {
                        karaokeHighlight: karaokeHL,
                        videoW: tw,
                        videoH: th,
                    })
                    : generateASS(task.segments, taskStyle);
                await window.electronAPI.burnSubtitles({
                    videoPath: bgPath, assContent, outputPath, crf,
                    useGPU: gpuEnabled,
                });
            } else {
                _reelsUpdateJobFastCapabilityUI(i, 'unsupported', '当前环境缺少极速导出接口');
                console.warn('[Reels] FFmpeg IPC not available, skipping:', task.fileName);
            }

        // 拼接前置片段 (Hook -> Main) — 仅 MP4 模式
            const finalHookPath = _resolveTaskHookPath(task, introPath);
            let currentOutputToConcat = doMp4 ? outputPath : finalOutputPath;

            if (doMp4 && finalHookPath && window.electronAPI && window.electronAPI.concatVideo) {
                const concatOutput = outputPath.replace('.mp4', '_final_tmp.mp4');
                _reelsUpdateJobProgressUI(i, Math.max(94, jobProgress[i] || 0), '拼接前置', 'running');
                await window.electronAPI.concatVideo({
                    introPath: finalHookPath,
                    mainPath: currentOutputToConcat,
                    outputPath: concatOutput,
                    speed: task.hookSpeed || 1.0,
                    trimStart: task.hookTrimStart !== undefined ? task.hookTrimStart : null,
                    trimEnd: task.hookTrimEnd !== undefined ? task.hookTrimEnd : null,
                    transition: task.hookTransition || 'none',
                    transDuration: task.hookTransDuration || 0.5,
                    targetWidth: tw,
                    targetHeight: th,
                    fps: 30
                });
                currentOutputToConcat = concatOutput;
            }

            // 拼接封面片段 (Cover -> [Hook] -> Main)
            if (coverMp4Path && doMp4 && window.electronAPI && window.electronAPI.concatVideo) {
                const coverConcatOutput = outputPath.replace('.mp4', '_final.mp4');
                _reelsUpdateJobProgressUI(i, Math.max(96, jobProgress[i] || 0), '拼接封面', 'running');
                if (statusEl) statusEl.textContent = `拼接中 ${i + 1}/${totalJobs}: 合并封面视频${presetLabel}...`;
                await window.electronAPI.concatVideo({
                    introPath: coverMp4Path,
                    mainPath: currentOutputToConcat,
                    outputPath: coverConcatOutput,
                    speed: 1.0,
                    transition: 'none',
                    transDuration: 0,
                    targetWidth: tw,
                    targetHeight: th,
                    fps: 30
                });
                currentOutputToConcat = coverConcatOutput;
            } else if (currentOutputToConcat.includes('_final_tmp.mp4')) {
                // 如果只拼接了 Hook 没有 Cover，重命名 _final_tmp 为 _final
                const finalTarget = outputPath.replace('.mp4', '_final.mp4');
                try {
                    await window.electronAPI.apiCall('file/rename', { source: currentOutputToConcat, target: finalTarget, copy: false });
                    currentOutputToConcat = finalTarget;
                } catch (e) { console.error('Rename final_tmp failed', e); }
            }

            finalOutputPath = currentOutputToConcat;

            // ── 清理中间产物：只保留最终拼接视频 ──
            if (finalOutputPath !== outputPath) {
                // outputPath 是拼接前的中间文件（如 _subtitled.mp4），删除它
                try {
                    await window.electronAPI.apiCall('file/delete', { path: outputPath });
                    console.log('[Reels] 清理中间文件:', outputPath);
                } catch (e) { console.warn('[Reels] 清理中间文件失败(可忽略):', e.message); }
                // 也清理可能残留的 _final_tmp.mp4
                const tmpFile = outputPath.replace('.mp4', '_final_tmp.mp4');
                if (tmpFile !== finalOutputPath) {
                    try {
                        await window.electronAPI.apiCall('file/delete', { path: tmpFile });
                    } catch (e) { /* 可能不存在，忽略 */ }
                }
            }

            // 默认不复制；仅在用户勾选且该任务来自文案自动剪辑时，在最终成片旁
            // 再放一份完整工程包。复制失败不影响已经成功的成片。
            if (copyProjectToOutput && doMp4 && task.autoEditProject) {
                const copiedProject = await _copyAutoEditProjectToReelsOutput(task, finalOutputPath);
                if (copiedProject?.ok) {
                    _reelsAppendExportLogUI(`${task.fileName}${presetLabel}：工程包已复制 → ${copiedProject.projectDir}`);
                } else if (!copiedProject?.skipped) {
                    const copyError = copiedProject?.error || '未知原因';
                    _reelsAppendExportLogUI(`${task.fileName}${presetLabel}：成片已导出，但工程包复制失败：${copyError}`, 'warning');
                    if (typeof showToast === 'function') showToast(`成片已导出，工程包复制失败：${copyError}`, 'warning', 8000);
                }
            }

            okCount += 1;
            _reelsUpdateJobProgressUI(i, 100, '已完成', 'success');
            _reelsState.lastExportOutputPath = finalOutputPath;
            _reelsUpdateLastOutputUI(finalOutputPath);
            _reelsAppendExportLogUI(`${task.fileName}${presetLabel}：导出完成 → ${finalOutputPath}`);
        } catch (err) {
            console.error('[Reels] Export failed:', task.fileName, err);
            failCount += 1;
            const rawErrMsg = err && err.message ? err.message : String(err || '未知错误');
            const errMsg = rawErrMsg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)*/i, '');
            failDetails.push(`${task.fileName}${presetLabel}: ${errMsg}`);
            _reelsAppendExportLogUI(`${task.fileName}${presetLabel} 导出失败：${errMsg}`, 'error');
            _reelsUpdateJobProgressUI(i, jobProgress[i], '失败', 'failed');
            if (statusEl) statusEl.textContent = `❌ 导出失败: ${task.fileName}${presetLabel} - ${errMsg}`;
            _reelsUpdateLastErrorUI(`${task.fileName}${presetLabel}: ${errMsg}`);
        }
        updateConcurrentOverallProgress(i, 100);
        completedOutOfOrder.add(i);
        while (completedOutOfOrder.has(contiguousCompletedIndex)) {
            completedOutOfOrder.delete(contiguousCompletedIndex);
            contiguousCompletedIndex += 1;
        }
        // 并发 2 时任务可能倒序完成。断点只能前进到“连续已完成”的位置，
        // 不能因为第 2 条先完成就跳过仍在处理的第 1 条。
        resumeManifest.nextIndex = contiguousCompletedIndex;
        resumeManifest.okCount = okCount;
        resumeManifest.failCount = failCount;
        resumeManifest.failDetails = failDetails.slice(-30);
        try { localStorage.setItem(REELS_EXPORT_RESUME_KEY, JSON.stringify(resumeManifest)); } catch (_) { }

        // 给 Chromium 一个释放上个任务 Canvas/解码图像的时机。长队列不连续
        // 无间隙启动下一条，否则已清空的底层像素内存仍可能延迟回收。
        await new Promise(resolve => setTimeout(resolve, totalJobs >= 24 ? 180 : 30));

    }
    };

    const runSegment = async () => {
        const workers = [];
        for (let w = 0; w < concurrency; w++) workers.push(processNext());
        await Promise.all(workers);
    };
    await runSegment();
    const shouldRefreshForRecycle = segmentedExport && !canceled && resumeManifest.nextIndex < totalJobs;
    if (shouldRefreshForRecycle) {
        resumeManifest.reloadPending = true;
        resumeManifest.reloadRequestedAt = Date.now();
        try {
            if (typeof _batchAutoSave === 'function') _batchAutoSave();
            if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
            _saveReelsExportSettings();
            localStorage.setItem(REELS_EXPORT_RESUME_KEY, JSON.stringify(resumeManifest));
        } catch (error) { console.warn('[Reels] 分段刷新前保存失败:', error); }
        _reelsState.isExporting = false;
        if (statusEl) statusEl.textContent = `已完成 ${resumeManifest.nextIndex}/${totalJobs}，正在刷新并自动续传…`;
        setTimeout(() => window.location.reload(), 500);
        return;
    }
    if (canceled) _reelsCancelUnfinishedJobProgressUI();

    // ── 按标签分组输出 FCPXML；未分组任务仍输出一个总时间线 ──
    if (doFcpxml && fcpxmlBatchTasks.length > 0 && !canceled && typeof window.reelsBatchFcpxmlExport === 'function') {
        const fcpxmlGroups = new Map();
        for (const item of fcpxmlBatchTasks) {
            const groupId = item.task?._batchTabId || '__ungrouped__';
            if (!fcpxmlGroups.has(groupId)) fcpxmlGroups.set(groupId, []);
            fcpxmlGroups.get(groupId).push(item);
        }
        for (const [groupId, groupTasks] of fcpxmlGroups) {
            const sourceTask = groupTasks[0]?.task;
            const rawGroupName = groupId === '__ungrouped__' ? '' : String(sourceTask?._batchTabName || '未命名分组');
            const safeGroupName = rawGroupName
                .replace(/[<>:"/\\|?*]+/g, '_')
                .replace(/[. ]+$/g, '')
                .trim();
            const groupOutputDir = safeGroupName
                ? `${outputDirTrimmed}${outputJoinSep}${safeGroupName}`
                : outputDirTrimmed;
            const batchName = safeGroupName
                ? `${safeGroupName}_Timeline_${dateStr}_${timeStr}`
                : `BatchTimeline_${dateStr}_${timeStr}`;
            try {
                if (window.electronAPI?.ensureDirectory) await window.electronAPI.ensureDirectory(groupOutputDir);
                if (statusEl) statusEl.textContent = `🚀 正在生成 FCPXML：${safeGroupName || '全部任务'}...`;
                const res = await window.reelsBatchFcpxmlExport({
                    tasks: groupTasks,
                    outputDir: groupOutputDir,
                    taskName: batchName,
                    fps: 30,
                    compoundMode: fcpxmlCompound,
                    onLog: (msg) => console.log(`[FCPXML ${safeGroupName || 'Bulk'}] ${msg}`)
                });
                _reelsState.lastExportOutputPath = res.outputPath;
                if (res.fusionPackage?.script_path) {
                    _reelsState.lastResolveFusionScriptPath = res.fusionPackage.script_path;
                    _reelsState.lastResolveFusionMenuScriptPath = res.fusionPackage.installed_path || '';
                    console.log(`[Resolve Fusion] ${res.fusionPackage.fusion_cues || 0} 条可编辑字幕脚本: ${res.fusionPackage.script_path}`);
                }
            } catch (err) {
                failCount += groupTasks.length;
                okCount = Math.max(0, okCount - groupTasks.length);
                const errMsg = err && err.message ? err.message : String(err);
                failDetails.push(`FCPXML「${safeGroupName || '全部任务'}」生成失败: ${errMsg}`);
                console.error(`[FCPXML] 分组 ${safeGroupName || '全部任务'} 生成失败:`, err);
            }
        }
    }

    const doneCount = okCount + failCount;
    _reelsUpdateExportProgressUI(doneCount, totalJobs);
    if (statusEl) {
        if (canceled) {
            statusEl.textContent = `⚠️ 已取消 (${doneCount}/${totalJobs})`;
        } else {
            const matrixNote = multiPresetCfg ? ` (${tasks.length}任务×${multiPresetCfg.presets.length}模板)` : '';
            statusEl.textContent = failCount > 0
                ? `⚠️ 完成 ${okCount}/${totalJobs}，失败 ${failCount}${matrixNote}`
                : `✅ 全部完成 (${totalJobs}个视频${matrixNote})`;
        }
    }
    if (!canceled && failCount > 0) {
        const shortErr = failDetails.slice(0, 5).join('\n');
        alert(`导出失败 ${failCount} 个\n输出目录: ${outputDirTrimmed}\n\n失败原因:\n${shortErr}`);
    } else if (!canceled && okCount > 0) {
        _reelsUpdateLastErrorUI('');
        const latest = _reelsState.lastExportOutputPath || `${outputDirTrimmed}${outputJoinSep}`;
        const fusionScript = _reelsState.lastResolveFusionScriptPath || '';
        const fusionNote = fusionScript
            ? `\nFusion 字幕已安装：${_reelsState.lastResolveFusionMenuScriptPath || fusionScript}\n重启 Resolve 后点 Workspace > Scripts > Comp > VideoKit Import Fusion，即可导入可编辑 Text+ 字幕。`
            : '';
        alert(`导出完成 ${okCount}/${totalJobs}\n输出目录: ${outputDirTrimmed}\n最新文件: ${latest}${fusionNote}`);
        // 自动打开输出文件夹
        if (window.electronAPI && window.electronAPI.apiCall) {
            try { await window.electronAPI.apiCall('file/open-folder', { path: outputDirTrimmed }); } catch (e) { }
        }
    }
    if (exportBtn) {
        exportBtn.disabled = false;
        exportBtn.innerHTML = '🚀 开始导出';
    }
    _reelsState.isExporting = false;
    try { localStorage.removeItem(REELS_EXPORT_RESUME_KEY); } catch (_) { }
}

// 分段释放内存后自动续传。仅接受 2 分钟内由程序主动发起的重载，
// 避免用户隔天打开应用时意外继续旧导出。
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        if (_reelsState.isExporting) return;
        let manifest = null;
        try { manifest = JSON.parse(localStorage.getItem(REELS_EXPORT_RESUME_KEY) || 'null'); } catch (_) { }
        if (!manifest?.active || !manifest.reloadPending) return;
        const age = Date.now() - (Number(manifest.reloadRequestedAt) || 0);
        if (!(age >= 0 && age < 120000)) {
            try { localStorage.removeItem(REELS_EXPORT_RESUME_KEY); } catch (_) { }
            return;
        }
        manifest.reloadPending = false;
        try { localStorage.setItem(REELS_EXPORT_RESUME_KEY, JSON.stringify(manifest)); } catch (_) { }
        reelsStartExport({ resumeState: manifest }).catch(error => {
            console.error('[Reels] 分段导出自动续传失败:', error);
            try { localStorage.removeItem(REELS_EXPORT_RESUME_KEY); } catch (_) { }
        });
    }, 2200);
});

// ═══════════════════════════════════════════════════════
// Smart Subtitle Processing (智能字幕处理)
// ═══════════════════════════════════════════════════════

/**
 * 智能重分段：按当前样式参数（字体大小、换行宽度等）重新分段当前任务的字幕。
 * 效果：自动调整每条字幕的文本量，确保不溢出预览区域。
 */
function reelsResegment() {
    if (!window.ReelsSubtitleProcessor) {
        alert('字幕处理器未加载');
        return;
    }
    const task = _reelsState.tasks[_reelsState.selectedIdx];
    if (!task?.segments?.length) {
        alert('当前选中任务没有可处理的字幕（请先选择一条带 SRT 的任务）');
        return;
    }
    const videoW = _reelsState.targetWidth || 1080;
    const style = _resolveSubtitleStyleForTask(task);
    const result = ReelsSubtitleProcessor.smartSegmentation(task.segments, style, videoW);
    if (!result || result.length === 0) {
        alert('当前字幕无法进行智能分段');
        return;
    }
    task.segments = result;
    // 智能分段属于用户在 Reels 中对字幕的实际编辑。后续手动“更新旧任务”
    // 只更新成片、保留这份已分段字幕，除非用户明确选择替换。
    task._manualSubtitleEdits = true;
    task._subtitleEditSource = 'smart_resegment';
    _renderTaskList();
    if (typeof _batchAutoSave === 'function') _batchAutoSave({ skipSync: true });
    if (typeof reelsSaveHistory === 'function') reelsSaveHistory();
    alert(`✅ 已智能重分段当前任务「${task.baseName || task.fileName || '未命名任务'}」的字幕\n\n已保存为手动字幕调整；以后更新旧任务时会默认保留。`);
}

/**
 * 合并短片段：合并时长过短的字幕到相邻字幕。
 */
function reelsMergeShort() {
    if (!window.ReelsSubtitleProcessor) {
        alert('字幕处理器未加载');
        return;
    }
    let totalProcessed = 0;
    for (const task of _reelsState.tasks) {
        if (!task.segments || task.segments.length === 0) continue;
        task.segments = ReelsSubtitleProcessor.mergeShortSegments(task.segments);
        totalProcessed++;
    }
    _renderTaskList();
    if (totalProcessed > 0) {
        alert(`✅ 已合并 ${totalProcessed} 个任务的短片段`);
    }
}

/**
 * 导出当前选中任务的字幕为 SRT 文件。
 */
function reelsExportSRT() {
    const task = _reelsState.tasks[_reelsState.selectedIdx];
    if (!task || !task.segments || task.segments.length === 0) {
        alert('请先选择一个带字幕的任务');
        return;
    }
    if (window.ReelsSubtitleProcessor) {
        const aDurScale = task.audioDurScale || 100;
        const factor = aDurScale / 100;
        const scaledSegments = (factor !== 1.0 && task.segments) 
            ? task.segments.map(s => ({ ...s, start: s.start * factor, end: s.end * factor, words: s.words ? s.words.map(w => ({...w, start: w.start * factor, end: w.end * factor})) : undefined }))
            : task.segments;

        const srtContent = ReelsSubtitleProcessor.segmentsToSRT(scaledSegments);
        const blob = new Blob([srtContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = task.fileName.replace(/\.[^.]+$/, '') + '_processed.srt';
        a.click();
        URL.revokeObjectURL(url);
    }
}

// ═══════════════════════════════════════════════════════
// Project Management
// ═══════════════════════════════════════════════════════

/**
 * 收集当前工程状态（供模板系统调用）
 */
function _cloneProjectDataForSave(value) {
    const seen = new WeakSet();
    const persistedPrivateFields = new Set([
        '_subtitlePreset', '_overlayPresetName',
        '_sourceFolder', '_folderQueueId', '_folderQueueName',
    ]);
    return JSON.parse(JSON.stringify(value, (key, val) => {
        if (key && key.startsWith('_') && !persistedPrivateFields.has(key)) return undefined;
        if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return undefined;
            seen.add(val);
        }
        return val;
    }));
}

function collectCurrentProjectState() {
    _syncCurrentOverlayEditorToSelectedTask();
    const style = _readStyleFromUI();
    _persistSubtitleStyleByScope(style);
    const globalStyle = _cloneSubtitleStyle(_reelsState.globalSubtitleStyle) || style;
    const exportOpts = {
        outputDir: (document.getElementById('reels-output-dir') || {}).value || '',
        copyProjectToOutput: (document.getElementById('reels-copy-project-to-output') || {}).checked || false,
        quality: (document.getElementById('reels-quality') || {}).value || 'medium',
        exportEngine: (document.getElementById('reels-export-engine') || {}).value || 'precise',
        customBitrateMbps: _readReelsCustomBitrate().target,
        customMaxBitrateMbps: _readReelsCustomBitrate().max,
        suffix: (document.getElementById('reels-suffix') || {}).value || '_subtitled',
        namingMode: (document.getElementById('reels-export-naming-mode-outer') || {}).value || (document.getElementById('reels-naming-mode') || {}).value || localStorage.getItem('reels_naming_mode') || 'text',
        namingStartDate: localStorage.getItem('reels_naming_start_date') || '',
        namingVidsPerDay: parseInt(localStorage.getItem('reels_naming_vids_per_day') || '3') || 3,
        namingPrefix: localStorage.getItem('reels_naming_prefix') || '',
        namingSuffix: localStorage.getItem('reels_naming_suffix') || '',
        voiceVolume: parseFloat((document.getElementById('reels-voice-volume') || {}).value || '100') || 100,
        bgVolume: _getGlobalBgVolumePercent(),
        bgmVolume: _getGlobalBgmVolumePercent(),
        useGPU: (document.getElementById('reels-use-gpu') || {}).checked || false,
        useMemoryDecoder: (document.getElementById('reels-use-memory-decoder') || {}).checked || false,
        previewLoop: (document.getElementById('reels-preview-loop') || {}).checked !== false,
        loopFade: (document.getElementById('reels-loop-fade') || {}).checked !== false,
        loopFadeDuration: parseFloat((document.getElementById('reels-loop-fade-dur') || {}).value || '1') || 1,
        introPath: (document.getElementById('reels-intro-path') || {}).value || '',
        karaokeHighlight: (document.getElementById('reels-karaoke-hl') || {}).checked || false,
        reverbEnabled: (document.getElementById('reels-reverb-enabled') || {}).checked || false,
        reverbPreset: (document.getElementById('reels-reverb-preset') || {}).value || 'hall',
        reverbMix: parseFloat((document.getElementById('reels-reverb-mix') || {}).value || '30') || 30,
        stereoWidth: parseFloat((document.getElementById('reels-stereo-width') || {}).value || '100') || 100,
        audioFxTarget: (document.getElementById('reels-audio-fx-target') || {}).value || 'all',
        subtitleStyleApplyAll: _isStyleApplyAllEnabled(),
        subtitleStyleScopeVersion: 2,
        subtitleStyleScope: _getSubtitleStyleScope(),
    };
    return {
        tasks: _cloneProjectDataForSave(_reelsState.tasks),
        backgroundLibrary: _cloneProjectDataForSave(_reelsState.backgroundLibrary || []),
        // 当前任务只是批量表格中一个标签页的投影；必须同时保存完整标签页，
        // 才能撤销跨标签的参数、素材池和行级修改。
        batchTable: window.reelsCaptureBatchTableState?.(),
        style: globalStyle,
        exportOpts,
        selectedIdx: _reelsState.selectedIdx,
    };
}

/**
 * 从模板/项目数据恢复工程状态（供模板系统调用）
 */
function applyRestoredProject(result) {
    if (!result) return;

    // ── 先清空覆层编辑器，防止旧覆层被 reelsSelectTask 写入新任务 ──
    if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        _reelsState.overlayProxy.overlayMgr.overlays = [];
    }
    if (_reelsState.overlayPanel) {
        _reelsState.overlayPanel.deselectOverlay();
        _reelsState.overlayPanel._refreshList();
    }
    _reelsState._coverEditMode = false;
    _reelsState.selectedIdx = -1; // 标记为无选中，防止 reelsSelectTask 回写

    // 恢复任务并自动清理 100% 的硬编码 bgVideoVolume，使其能够继承全局配置音量
    _reelsState.tasks = Array.isArray(result.tasks) ? result.tasks.map(task => {
        if (task && task.bgVideoVolume === 100) {
            delete task.bgVideoVolume;
        }
        return task;
    }) : [];
    _reelsState.selectedIdx = _reelsState.tasks.length > 0
        ? Math.max(0, Math.min(result.selectedIdx >= 0 ? result.selectedIdx : 0, _reelsState.tasks.length - 1))
        : -1;
    _reelsState.backgroundLibrary = _isRestoringHistory ? _cloneProjectDataForSave(result.backgroundLibrary || []) : [];
    _ensureBackgroundLibraryFromTasks();

    // 在渲染/同步当前标签之前恢复完整批量表格快照，避免撤销时把其他标签页
    // 的任务、素材配置和参数覆盖成当前任务页的数据。
    const restoredBatchTable = !!(result.batchTable && typeof window.reelsRestoreBatchTableState === 'function');
    if (restoredBatchTable) {
        window.reelsRestoreBatchTableState(result.batchTable);
    }

    // Keep the batch-table active tab in sync so loaded template paths appear
    // in the table as well as in the Reels task list.
    if (!restoredBatchTable && typeof _batchTableState !== 'undefined' && typeof _getActiveTab === 'function') {
        const tab = _getActiveTab();
        if (tab) {
            try {
                tab.tasks = _cloneProjectDataForSave(_reelsState.tasks);
            } catch (_) {
                tab.tasks = _reelsState.tasks.map(t => ({ ...t }));
            }
        }
    }

    // 恢复样式
    if (result.style && Object.keys(result.style).length > 0) {
        _reelsState.globalSubtitleStyle = _cloneSubtitleStyle(result.style);
    }

    // 恢复导出选项
    if (result.exportOpts) {
        const opts = result.exportOpts;
        const setVal = (id, val) => {
            _setExportSettingValue(id, val);
        };
        const setCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
        const preferredDir = _readPreferredReelsOutputDir();
        if (preferredDir || opts.outputDir) setVal('reels-output-dir', preferredDir || opts.outputDir);
        if (opts.copyProjectToOutput !== undefined) setCheck('reels-copy-project-to-output', opts.copyProjectToOutput);
        if (opts.quality) setVal('reels-quality', opts.quality);
        if (opts.exportEngine) setVal('reels-export-engine', opts.exportEngine === 'experimental' ? 'hardware' : opts.exportEngine);
        if (opts.customBitrateMbps !== undefined) setVal('reels-custom-bitrate', opts.customBitrateMbps);
        if (opts.customMaxBitrateMbps !== undefined) setVal('reels-custom-max-bitrate', opts.customMaxBitrateMbps);
        reelsUpdateCustomBitrateUI();
        reelsUpdateExportEngineUI();
        if (opts.suffix) setVal('reels-suffix', opts.suffix);
        if (opts.namingMode) {
            setVal('reels-naming-mode', opts.namingMode);
            setVal('reels-export-naming-mode-outer', opts.namingMode);
            localStorage.setItem('reels_naming_mode', opts.namingMode);
            
            // Sync gear button visibility
            const configBtnOuter = document.getElementById('reels-export-naming-config-btn');
            if (configBtnOuter) {
                configBtnOuter.style.display = (opts.namingMode === 'index' || opts.namingMode === 'date-auto') ? 'inline-block' : 'none';
            }
            const configBtnInner = document.getElementById('reels-naming-config-btn');
            if (configBtnInner) {
                configBtnInner.style.display = (opts.namingMode === 'index' || opts.namingMode === 'date-auto') ? 'inline-block' : 'none';
            }
        }
        if (opts.namingStartDate !== undefined) localStorage.setItem('reels_naming_start_date', opts.namingStartDate || '');
        if (opts.namingVidsPerDay !== undefined) localStorage.setItem('reels_naming_vids_per_day', String(opts.namingVidsPerDay));
        if (opts.namingPrefix !== undefined) localStorage.setItem('reels_naming_prefix', opts.namingPrefix || '');
        if (opts.namingSuffix !== undefined) localStorage.setItem('reels_naming_suffix', opts.namingSuffix || '');
        if (opts.voiceVolume !== undefined && opts.voiceVolume !== null) setVal('reels-voice-volume', String(opts.voiceVolume));
        if (opts.bgVolume !== undefined && opts.bgVolume !== null) setVal('reels-bg-volume', String(opts.bgVolume));
        if (opts.bgmVolume !== undefined && opts.bgmVolume !== null) setVal('reels-bgm-volume', String(opts.bgmVolume));
        setCheck('reels-use-gpu', opts.useGPU);
        setCheck('reels-use-memory-decoder', opts.useMemoryDecoder === true);
        setCheck('reels-preview-loop', opts.previewLoop !== false);
        setCheck('reels-loop-fade', opts.loopFade !== false);
        if (opts.loopFadeDuration !== undefined && opts.loopFadeDuration !== null) {
            const dur = parseFloat(opts.loopFadeDuration);
            if (Number.isFinite(dur) && dur > 0) setVal('reels-loop-fade-dur', String(dur));
        }
        if (opts.introPath) setVal('reels-intro-path', opts.introPath);
        setCheck('reels-karaoke-hl', opts.karaokeHighlight);
        setCheck('reels-reverb-enabled', opts.reverbEnabled);
        if (opts.reverbPreset) setVal('reels-reverb-preset', opts.reverbPreset);
        if (opts.reverbMix !== undefined) setVal('reels-reverb-mix', String(opts.reverbMix));
        if (opts.stereoWidth !== undefined) setVal('reels-stereo-width', String(opts.stereoWidth));
        if (opts.audioFxTarget !== undefined) setVal('reels-audio-fx-target', opts.audioFxTarget);
        const restoredStyleScope = opts.subtitleStyleScopeVersion === 2
            ? (opts.subtitleStyleScope || (opts.subtitleStyleApplyAll === true ? 'all' : 'folder'))
            : 'folder';
        setVal('reels-style-scope', restoredStyleScope);
        _reelsState.lastSubtitleStyleScope = restoredStyleScope;


        
        // 恢复分辨率设置
        const tw = opts.targetWidth || 1080;
        const th = opts.targetHeight || 1920;
        _reelsState.targetWidth = tw;
        _reelsState.targetHeight = th;
        
        const resSelect = document.getElementById('reels-resolution-select');
        const customDiv = document.getElementById('reels-custom-res-inputs');
        const wVal = `${tw}x${th}`;
        if (resSelect) {
            let optionExists = false;
            for (let i = 0; i < resSelect.options.length; i++) {
                if (resSelect.options[i].value === wVal) {
                    resSelect.value = wVal;
                    optionExists = true;
                    break;
                }
            }
            if (!optionExists) {
                resSelect.value = 'custom';
                if (customDiv) customDiv.style.display = 'inline-flex';
                const wInput = document.getElementById('reels-custom-width');
                const hInput = document.getElementById('reels-custom-height');
                const wRange = document.getElementById('reels-custom-width-range');
                const hRange = document.getElementById('reels-custom-height-range');
                if (wInput) wInput.value = tw;
                if (hInput) hInput.value = th;
                if (wRange) wRange.value = tw;
                if (hRange) hRange.value = th;
            } else {
                if (customDiv) customDiv.style.display = 'none';
            }
        }
        _reelsUpdateResolutionUI(tw, th);
        const canvas = document.getElementById('reels-preview-canvas');
        if (canvas) {
            canvas.width = tw;
            canvas.height = th;
        }

        _applyPreviewLoopMode();
    }


    const selectedTask = _reelsState.tasks[_reelsState.selectedIdx] || null;
    const styleToShow = _resolveSubtitleStyleForTask(selectedTask);
    if (styleToShow) _writeStyleToUI(styleToShow);

    if (selectedTask) {
        // 必须先重置 selectedIdx=-1，否则 reelsSelectTask 的 "保存上一个任务覆层"
        // 逻辑会把空的 overlayMgr 内容写入刚加载的模板任务
        const targetIdx = _reelsState.selectedIdx;
        _reelsState.selectedIdx = -1;
        reelsSelectTask(targetIdx);
    } else {
        _renderTaskList();
    }
    if (typeof _renderBatchTable === 'function') {
        // Loading a template/project replaces state from JSON. The batch table may
        // still contain stale DOM inputs from the previous project, so skip its
        // automatic DOM -> task sync for this first redraw.
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    _applyPreviewAudioMix();
    reelsUpdatePreview();

    if (result.warnings && result.warnings.length > 0) {
        console.warn('[Project] Warnings:', result.warnings);
    }
    const statusEl = document.getElementById('reels-export-status');
    if (statusEl) statusEl.textContent = `✅ 已加载 ${result.tasks.length} 个任务`;

    if (!_isRestoringHistory && typeof window.reelsSaveHistory === 'function') {
        _reelsHistoryStack = [];
        _reelsHistoryIndex = -1;
        window.reelsSaveHistory();
    }
}

function reelsSaveProject(event) {
    // 原生“另存为”窗口绝不能由启动恢复、热更新或脚本误触发；只响应用户
    // 实际点击菜单项。当前没有其他合法的程序调用方。
    if (!event?.isTrusted) {
        console.warn('[Reels] 忽略非用户触发的保存工程请求');
        return;
    }
    if (!window.ReelsProject) { alert('项目管理模块未加载'); return; }
    _syncCurrentOverlayEditorToSelectedTask();
    const style = _readStyleFromUI();
    _persistSubtitleStyleByScope(style);
    const globalStyle = _cloneSubtitleStyle(_reelsState.globalSubtitleStyle) || style;
    const exportOpts = {
        outputDir: (document.getElementById('reels-output-dir') || {}).value || '',
        copyProjectToOutput: (document.getElementById('reels-copy-project-to-output') || {}).checked || false,
        quality: (document.getElementById('reels-quality') || {}).value || 'medium',
        exportEngine: (document.getElementById('reels-export-engine') || {}).value || 'precise',
        customBitrateMbps: _readReelsCustomBitrate().target,
        customMaxBitrateMbps: _readReelsCustomBitrate().max,
        suffix: (document.getElementById('reels-suffix') || {}).value || '_subtitled',
        namingMode: (document.getElementById('reels-export-naming-mode-outer') || {}).value || (document.getElementById('reels-naming-mode') || {}).value || localStorage.getItem('reels_naming_mode') || 'text',
        namingStartDate: localStorage.getItem('reels_naming_start_date') || '',
        namingVidsPerDay: parseInt(localStorage.getItem('reels_naming_vids_per_day') || '3') || 3,
        namingPrefix: localStorage.getItem('reels_naming_prefix') || '',
        namingSuffix: localStorage.getItem('reels_naming_suffix') || '',
        voiceVolume: parseFloat((document.getElementById('reels-voice-volume') || {}).value || '100') || 100,
        bgVolume: _getGlobalBgVolumePercent(),
        useGPU: (document.getElementById('reels-use-gpu') || {}).checked || false,
        useMemoryDecoder: (document.getElementById('reels-use-memory-decoder') || {}).checked || false,
        previewLoop: (document.getElementById('reels-preview-loop') || {}).checked !== false,
        loopFade: (document.getElementById('reels-loop-fade') || {}).checked !== false,
        loopFadeDuration: parseFloat((document.getElementById('reels-loop-fade-dur') || {}).value || '1') || 1,
        introPath: (document.getElementById('reels-intro-path') || {}).value || '',
        karaokeHighlight: (document.getElementById('reels-karaoke-hl') || {}).checked || false,
        reverbEnabled: (document.getElementById('reels-reverb-enabled') || {}).checked || false,
        reverbPreset: (document.getElementById('reels-reverb-preset') || {}).value || 'hall',
        reverbMix: parseFloat((document.getElementById('reels-reverb-mix') || {}).value || '30') || 30,
        stereoWidth: parseFloat((document.getElementById('reels-stereo-width') || {}).value || '100') || 100,
        audioFxTarget: (document.getElementById('reels-audio-fx-target') || {}).value || 'all',
        subtitleStyleApplyAll: _isStyleApplyAllEnabled(),
        subtitleStyleScopeVersion: 2,
        subtitleStyleScope: _getSubtitleStyleScope(),
        targetWidth: _reelsState.targetWidth || 1080,
        targetHeight: _reelsState.targetHeight || 1920,
    };

    ReelsProject.saveProject({
        tasks: _reelsState.tasks,
        style: globalStyle,
        exportOpts,
        selectedIdx: _reelsState.selectedIdx,
    }, { interactive: true });
}

async function reelsLoadProject() {
    if (!window.ReelsProject) { alert('项目管理模块未加载'); return; }
    const result = await ReelsProject.loadProject();
    if (!result) return;
    applyRestoredProject(result);
}

// ═══════════════════════════════════════════════════════
// History (Undo / Redo)
// ═══════════════════════════════════════════════════════

let _reelsHistoryStack = [];
let _reelsHistoryIndex = -1;
let _isRestoringHistory = false;
const _reelsHistoryStrings = new Map();
const _reelsHistoryStringIds = new Map();
let _reelsHistoryNextStringId = 1;
const _reelsHistoryResourceRefs = new Map();
function _encodeReelsHistory(state) {
    if(!_reelsHistoryStack.length){_reelsHistoryStrings.clear();_reelsHistoryStringIds.clear();_reelsHistoryNextStringId=1;_reelsHistoryResourceRefs.clear();}
    const refs=new Set();
    const encoded=JSON.stringify(state,(key,value)=>{
        if(typeof value!=='string'||value.length<1024)return value;
        let id=_reelsHistoryStringIds.get(value);
        if(!id){id=_reelsHistoryNextStringId++;_reelsHistoryStringIds.set(value,id);_reelsHistoryStrings.set(id,value);}
        refs.add(id);return {__vk_undo_string_v1:id};
    });
    _reelsHistoryResourceRefs.set(encoded,refs);return encoded;
}
function _decodeReelsHistory(value) {
    return JSON.parse(value,(key,item)=>{
        if(item&&typeof item==='object'&&Object.keys(item).length===1&&item.__vk_undo_string_v1){
            if(!_reelsHistoryStrings.has(item.__vk_undo_string_v1))throw new Error('撤销资源缺失');
            return _reelsHistoryStrings.get(item.__vk_undo_string_v1);
        }
        return item;
    });
}
function _collectReelsHistoryStrings() {
    const used=new Set();
    const retained=new Set(_reelsHistoryStack);
    for(const [snapshot,refs]of _reelsHistoryResourceRefs){if(!retained.has(snapshot)){_reelsHistoryResourceRefs.delete(snapshot);continue;}for(const id of refs)used.add(id);}
    for(const [id,value]of _reelsHistoryStrings)if(!used.has(id)){_reelsHistoryStrings.delete(id);_reelsHistoryStringIds.delete(value);}
}
function _trimReelsHistory(settings) {
    _collectReelsHistoryStrings();
    // Retain one undo even when a single project exceeds the chosen budget.
    while(_reelsHistoryStack.length>2&&(_reelsHistoryStack.length>settings.maxSteps||_historyBytes()>settings.maxBytes)){
        _reelsHistoryStack.shift();_reelsHistoryIndex=Math.max(-1,_reelsHistoryIndex-1);_collectReelsHistoryStrings();
    }
}
function _cloneReelsHistoryTasks(tasks) {
    const allowed=new Set(['_subtitlePreset','_overlayPresetName','_sourceFolder','_folderQueueId','_folderQueueName']);
    function clone(value,seen=new WeakSet()){
        if(!value||typeof value!=='object')return value;
        if(value instanceof Date)return value.toISOString();
        if(seen.has(value))return undefined;seen.add(value);
        if(Array.isArray(value))return value.map(v=>clone(v,seen));
        const out={};for(const [k,v]of Object.entries(value))if((!k.startsWith('_')||allowed.has(k))&&typeof v!=='function')out[k]=clone(v,seen);return out;
    }
    const clones=clone(tasks);
    clones.forEach((task,i)=>{for(const key of ['_batchProjection','_batchTabId','_batchTabName','_batchTabOrder','_batchTaskOrder'])if(tasks[i][key]!==undefined)task[key]=tasks[i][key];});
    return clones;
}

function _captureReelsHistoryState() {
    const style = _readStyleFromUI();
    const globalStyle = _cloneSubtitleStyle(_reelsState.globalSubtitleStyle) || style;
    const exportOpts = {
        outputDir: (document.getElementById('reels-output-dir') || {}).value || '',
        copyProjectToOutput: (document.getElementById('reels-copy-project-to-output') || {}).checked || false,
        quality: (document.getElementById('reels-quality') || {}).value || 'medium',
        exportEngine: (document.getElementById('reels-export-engine') || {}).value || 'precise',
        customBitrateMbps: _readReelsCustomBitrate().target,
        customMaxBitrateMbps: _readReelsCustomBitrate().max,
        suffix: (document.getElementById('reels-suffix') || {}).value || '_subtitled',
        namingMode: (document.getElementById('reels-export-naming-mode-outer') || {}).value || (document.getElementById('reels-naming-mode') || {}).value || localStorage.getItem('reels_naming_mode') || 'text',
        namingStartDate: localStorage.getItem('reels_naming_start_date') || '',
        namingVidsPerDay: parseInt(localStorage.getItem('reels_naming_vids_per_day') || '3') || 3,
        namingPrefix: localStorage.getItem('reels_naming_prefix') || '',
        namingSuffix: localStorage.getItem('reels_naming_suffix') || '',
        voiceVolume: parseFloat((document.getElementById('reels-voice-volume') || {}).value || '100') || 100,
        bgVolume: _getGlobalBgVolumePercent(),
        bgmVolume: _getGlobalBgmVolumePercent(),
        useGPU: (document.getElementById('reels-use-gpu') || {}).checked || false,
        useMemoryDecoder: (document.getElementById('reels-use-memory-decoder') || {}).checked || false,
        previewLoop: (document.getElementById('reels-preview-loop') || {}).checked !== false,
        loopFade: (document.getElementById('reels-loop-fade') || {}).checked !== false,
        loopFadeDuration: parseFloat((document.getElementById('reels-loop-fade-dur') || {}).value || '1') || 1,
        introPath: (document.getElementById('reels-intro-path') || {}).value || '',
        karaokeHighlight: (document.getElementById('reels-karaoke-hl') || {}).checked || false,
        reverbEnabled: (document.getElementById('reels-reverb-enabled') || {}).checked || false,
        reverbPreset: (document.getElementById('reels-reverb-preset') || {}).value || 'hall',
        reverbMix: parseFloat((document.getElementById('reels-reverb-mix') || {}).value || '30') || 30,
        stereoWidth: parseFloat((document.getElementById('reels-stereo-width') || {}).value || '100') || 100,
        audioFxTarget: (document.getElementById('reels-audio-fx-target') || {}).value || 'all',
        subtitleStyleApplyAll: _isStyleApplyAllEnabled(),
        subtitleStyleScopeVersion: 2,
        subtitleStyleScope: _getSubtitleStyleScope(),
    };
    return {
        tasks: _cloneReelsHistoryTasks(_reelsState.tasks),
        backgroundLibrary: _cloneReelsHistoryTasks(_reelsState.backgroundLibrary || []),
        // 当前任务只是批量表格中一个标签页的投影；必须同时保存完整标签页，
        // 才能撤销跨标签的参数、素材池和行级修改。
        batchTable: window.reelsCaptureBatchTableState?.(),
        style: globalStyle,
        exportOpts,
        selectedIdx: _reelsState.selectedIdx,
    };
}

const REELS_HISTORY_SETTINGS_KEY = 'videokit_reels_history_settings_v1';
const REELS_HISTORY_DEFAULTS = Object.freeze({ maxSteps: 300, maxBytes: 100 * 1024 * 1024 });

function _readReelsHistorySettings() {
    try {
        const stored = JSON.parse(localStorage.getItem(REELS_HISTORY_SETTINGS_KEY) || '{}');
        return {
            maxSteps: Math.max(30, Math.min(1000, Number(stored.maxSteps) || REELS_HISTORY_DEFAULTS.maxSteps)),
            maxBytes: Math.max(10 * 1024 * 1024, Math.min(500 * 1024 * 1024, Number(stored.maxBytes) || REELS_HISTORY_DEFAULTS.maxBytes)),
        };
    } catch (_) {
        return { ...REELS_HISTORY_DEFAULTS };
    }
}

function _historyBytes() {
    // JS 字符串通常以 UTF-16 保存；近似值足够用来控制内存上限。
    return _reelsHistoryStack.reduce((total, item) => total + String(item || '').length * 2, 0) + Array.from(_reelsHistoryStrings.values()).reduce((sum,value)=>sum+value.length*2,0);
}

window.reelsGetHistorySettings = function() {
    return { ..._readReelsHistorySettings(), currentSteps: _reelsHistoryStack.length, currentBytes: _historyBytes() };
};

window.reelsSetHistorySettings = function(input = {}) {
    const previous = _readReelsHistorySettings();
    const next = {
        maxSteps: Math.max(30, Math.min(1000, Number(input.maxSteps) || previous.maxSteps)),
        maxBytes: Math.max(10 * 1024 * 1024, Math.min(500 * 1024 * 1024, Number(input.maxBytes) || previous.maxBytes)),
    };
    localStorage.setItem(REELS_HISTORY_SETTINGS_KEY, JSON.stringify(next));
    _trimReelsHistory(next);
    return window.reelsGetHistorySettings();
};

window.reelsSaveHistory = function() {
    if (_reelsHistoryRangeGesture || _isRestoringHistory || !window._reelsState || typeof collectCurrentProjectState !== 'function') return;
    try {
        const stateStr = _encodeReelsHistory(_captureReelsHistoryState());
        // 如果与当前处于相同状态则不保存
        if (_reelsHistoryIndex >= 0 && _reelsHistoryStack[_reelsHistoryIndex] === stateStr) {
            return;
        }
        // 如果在撤销中途发生了新的修改，截断之后的重做记录
        if (_reelsHistoryIndex < _reelsHistoryStack.length - 1) {
            _reelsHistoryStack = _reelsHistoryStack.slice(0, _reelsHistoryIndex + 1);
        }
        _reelsHistoryStack.push(stateStr);
        _reelsHistoryIndex = _reelsHistoryStack.length - 1;
        const settings = _readReelsHistorySettings();
        // 两道限制：步数和占用。达到任一限制都淘汰最早状态。
        _trimReelsHistory(settings);
    } catch (e) {
        console.warn('[History] Failed to save history snapshot', e);
    }
};

window.reelsUndo = function() {
    _flushReelsHistory();
    if (_reelsHistoryIndex > 0) {
        _reelsHistoryIndex--;
        _isRestoringHistory = true;
        try {
            const state = _decodeReelsHistory(_reelsHistoryStack[_reelsHistoryIndex]);
            applyRestoredProject(state);
            const statusEl = document.getElementById('reels-export-status');
            if (statusEl) statusEl.textContent = '⏪ 撤销成功';
            console.log('[History] Undo completed');
        } catch (e) {
            console.error('[History] Undo error', e);
        } finally {
            _isRestoringHistory = false;
        }
    } else {
        console.log('[History] No more undo steps');
    }
};

window.reelsRedo = function() {
    _flushReelsHistory();
    if (_reelsHistoryIndex < _reelsHistoryStack.length - 1) {
        _reelsHistoryIndex++;
        _isRestoringHistory = true;
        try {
            const state = _decodeReelsHistory(_reelsHistoryStack[_reelsHistoryIndex]);
            applyRestoredProject(state);
            const statusEl = document.getElementById('reels-export-status');
            if (statusEl) statusEl.textContent = '⏩ 重做成功';
            console.log('[History] Redo completed');
        } catch (e) {
            console.error('[History] Redo error', e);
        } finally {
            _isRestoringHistory = false;
        }
    } else {
        console.log('[History] No more redo steps');
    }
};

function _reelsHistoryEventInEditor(event) {
    const panel=document.getElementById('batch-reels-panel');
    return !!(panel?.classList.contains('active')||event.target?.closest?.('#reels-batch-table-container'));
}
function _reelsHistoryNativeText(target) {
    return !!(target?.isContentEditable||target?.tagName==='TEXTAREA'||(target?.tagName==='INPUT'&&['text','search','password','url','email','tel'].includes(target.type)));
}
document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing||event.altKey||!(event.ctrlKey||event.metaKey)||!_reelsHistoryEventInEditor(event))return;
    const key=event.key.toLowerCase();if(key!=='z'&&key!=='y')return;
    if(_reelsHistoryNativeText(event.target))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(key==='y'||event.shiftKey)window.reelsRedo();else window.reelsUndo();
},true);
let _reelsHistoryRangeGesture=false,_reelsHistoryPending=null;
function _flushReelsHistory(){if(_reelsHistoryPending!==null){clearTimeout(_reelsHistoryPending);_reelsHistoryPending=null;window.reelsSaveHistory();}}
for(const name of ['pointerdown','beforeinput'])document.addEventListener(name,event=>{
    if(!_reelsHistoryEventInEditor(event)||_isRestoringHistory)return;
    if(name==='pointerdown'&&!event.target?.closest?.('input,textarea,select,button,canvas,[onclick],[contenteditable]'))return;
    if(_reelsHistoryPending===null)window.reelsSaveHistory();
    if(name==='pointerdown'&&event.target?.type==='range')_reelsHistoryRangeGesture=true;
},true);
for(const name of ['input','change','click','pointerup'])document.addEventListener(name,event=>{
    if(!_reelsHistoryEventInEditor(event)||_isRestoringHistory)return;
    if(name==='pointerup')_reelsHistoryRangeGesture=false;
    if(_reelsHistoryRangeGesture)return;
    if(name==='click'&&!event.target?.closest?.('input,select,button,[onclick]'))return;
    clearTimeout(_reelsHistoryPending);
    _reelsHistoryPending=setTimeout(()=>{_reelsHistoryPending=null;if(!_isRestoringHistory)window.reelsSaveHistory();},name==='input'?350:0);
});
setTimeout(()=>window.reelsSaveHistory?.(),2000);

// ═══════════════════════════════════════════════════════
// Font Upload
// ═══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    // 字体上传处理
    const fontInput = document.getElementById('reels-font-upload');
    if (fontInput) {
        fontInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (window.getFontManager) {
                const fm = getFontManager();
                const familyName = await fm.uploadFont(file);
                if (familyName) {
                    _refreshReelsFontSelects(fm, {
                        'reels-font-family': familyName,
                        'rop-font': familyName,
                        'rop-title-font': familyName,
                        'rop-body-font': familyName,
                        'rop-footer-font': familyName,
                        'rop-scroll-font': familyName,
                        'rop-scroll-title-font': familyName,
                    });
                    const familyEl = document.getElementById('reels-font-family');
                    if (familyEl) familyEl.value = familyName;
                    reelsRefreshSubtitleWeightOptions();
                    reelsUpdatePreview();
                    alert(`字体 "${familyName}" 已加载！`);
                }
            } else {
                alert('字体管理器未加载');
            }
            fontInput.value = '';
        });
    }

    // 初始化字体管理器
    if (window.getFontManager) {
        const fm = getFontManager();
        fm.register().then(() => {
            _refreshReelsFontSelects(fm);
            fm.loadGoogleFont('Crimson Pro').catch(() => { });
            reelsRefreshSubtitleWeightOptions();
        });
    }

    // 自动保存 (每 60 秒)
    setInterval(() => {
        if (_reelsState.tasks.length > 0 && window.ReelsProject) {
            const style = _readStyleFromUI();
            _persistSubtitleStyleByScope(style);
            const globalStyle = _cloneSubtitleStyle(_reelsState.globalSubtitleStyle) || style;
            ReelsProject.autoSaveProject({
                tasks: _reelsState.tasks,
                style: globalStyle,
                selectedIdx: _reelsState.selectedIdx,
            });
        }
    }, 60000);
});

// ═══════════════════════════════════════════════════════
// Tab visibility observer
// ═══════════════════════════════════════════════════════

if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => {
        const panel = document.getElementById('batch-reels-panel');
        if (panel && panel.classList.contains('active')) {
            _fitPreviewWhenReady();
            reelsUpdatePreview();
        } else {
            if (_reelsState.previewRAF) {
                cancelAnimationFrame(_reelsState.previewRAF);
                _reelsState.previewRAF = null;
            }
        }
    });
    setTimeout(() => {
        const panel = document.getElementById('batch-reels-panel');
        if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
    }, 500);
}

// ═══════════════════════════════════════════════════════
// UI Interaction Hook for Style Overrides
// ═══════════════════════════════════════════════════════
function reelsMarkStyleDirty(e) {
    const el = e.target;
    if (!el || !el.closest) return;
    if (
        !el.closest('#reels-style-panel') &&
        !el.closest('#reels-advanced-style-panel') &&
        !el.closest('#inspector-tab-subtitle')
    ) return;
    
    // Ignore non-style inputs
    if (el.id === 'reels-style-scope' || el.id === 'reels-preset-select' ||
        el.id === 'reels-subtitle-toggle' || el.id === 'reels-overlay-toggle' ||
        el.id === 'reels-show-subtitle-range') return;

    // User actively modified a style parameter, breaking the preset link
    const applyAll = typeof _isStyleApplyAllEnabled === 'function' ? _isStyleApplyAllEnabled() : true;
    let modified = false;
    
    if (applyAll && window._reelsState && window._reelsState.tasks) {
        for (const t of window._reelsState.tasks) {
            if (t._subtitlePreset) { t._subtitlePreset = ''; modified = true; }
        }
    } else {
        const scope = typeof _getSubtitleStyleScope === 'function' ? _getSubtitleStyleScope() : 'task';
        const targets = scope === 'folder' ? _getCurrentReelsGroupTasks() : [_getSelectedTask()].filter(Boolean);
        for (const task of targets) {
            if (task && task._subtitlePreset) { task._subtitlePreset = ''; modified = true; }
        }
    }

    if (modified) {
        const selectTrigger = document.getElementById('reels-preset-select-trigger');
        const hiddenInput = document.getElementById('reels-preset-select');
        if (hiddenInput) hiddenInput.value = '';
        if (selectTrigger) {
            const span = selectTrigger.querySelector('span');
            if (span) span.textContent = '-- 自定义样式 --';
        }
    }

    // Ensure paired controls (such as highlight toggles and -range sliders) are
    // synchronized before reading UI state, even if a listener runs before inline handlers.
    if (el.id === 'reels-highlight-enabled') {
        const k = document.getElementById('reels-karaoke-hl');
        if (k) k.checked = el.checked;
    } else if (el.id === 'reels-karaoke-hl') {
        const h = document.getElementById('reels-highlight-enabled');
        if (h) h.checked = el.checked;
    } else if (el.id && el.id.endsWith('-range')) {
        const paired = document.getElementById(el.id.slice(0, -6));
        if (paired) paired.value = el.value;
    }

    // 只有用户真实改动某个样式控件时才写入当前作用域；预览/任务切换不写。
    // input/change 在控件值更新后触发，这里读取到的是最终值。
    _persistSubtitleStyleByScope(_readStyleFromUI());
    if (window.ReelsPreviewV2?.isOpen?.()) {
        window.ReelsPreviewV2.render?.();
    }
}

// ═══════════════════════════════════════════════════════
// Resolution Customization
// ═══════════════════════════════════════════════════════
window.reelsHandleResolutionChange = function(val) {
    const customDiv = document.getElementById('reels-custom-res-inputs');
    if (val === 'custom') {
        if (customDiv) customDiv.style.display = 'inline-flex';
        reelsHandleCustomResolutionChange();
    } else {
        if (customDiv) customDiv.style.display = 'none';
        const parts = val.split('x');
        const w = parseInt(parts[0], 10);
        const h = parseInt(parts[1], 10);
        _reelsUpdateResolution(w, h);
    }
};

window.reelsHandleCustomResolutionChange = function() {
    const wInput = document.getElementById('reels-custom-width');
    const hInput = document.getElementById('reels-custom-height');
    const wRange = document.getElementById('reels-custom-width-range');
    const hRange = document.getElementById('reels-custom-height-range');
    if (wInput && hInput) {
        const w = parseInt(wInput.value, 10) || 1080;
        const h = parseInt(hInput.value, 10) || 1920;
        if (wRange) wRange.value = w;
        if (hRange) hRange.value = h;
        _reelsUpdateResolution(w, h);
    }
};

function _reelsUpdateResolution(w, h) {
    _reelsState.targetWidth = w;
    _reelsState.targetHeight = h;

    const canvas = document.getElementById('reels-preview-canvas');
    if (canvas) {
        canvas.width = w;
        canvas.height = h;
    }

    _reelsUpdateResolutionUI(w, h);

    reelsUpdatePreview();
    _fitPreviewWhenReady();
}

function _reelsUpdateResolutionUI(w, h) {
    const container = document.getElementById('reels-preview-container');
    if (container) {
        container.style.aspectRatio = `${w}/${h}`;
        if (w >= h) {
            container.style.width = '380px';
        } else {
            container.style.width = '270px';
        }
    }
}

document.addEventListener('input', reelsMarkStyleDirty, false);
document.addEventListener('change', reelsMarkStyleDirty, false);

// ─── 统一的文件选择器辅助函数 ───
async function _pickSingleFile(title, extensions) {
    // preload 对页面暴露的原生选择器是 selectFiles。优先使用它才能在
    // Windows + contextIsolation 下拿到 C:\\... 形式的完整路径。浏览器
    // <input type="file"> 的 File.path 在新版 Electron 中可能不再提供。
    if (window.electronAPI && typeof window.electronAPI.selectFiles === 'function') {
        try {
            const filePaths = await window.electronAPI.selectFiles({
                title: title,
                multiple: false,
                filters: [{ name: '媒体文件', extensions: extensions }]
            });
            if (Array.isArray(filePaths) && filePaths.length > 0) {
                return filePaths[0];
            }
            return null;
        } catch (e) {
            console.error('electronAPI selectFiles error:', e);
        }
    }
    if (window.electronAPI && window.electronAPI.showOpenDialog) {
        try {
            const result = await window.electronAPI.showOpenDialog({
                title: title,
                properties: ['openFile'],
                filters: [{ name: '媒体文件', extensions: extensions }]
            });
            if (result && result.filePaths && result.filePaths.length > 0) {
                return result.filePaths[0];
            }
        } catch (e) {
            console.error('electronAPI showOpenDialog error:', e);
        }
    }
    if (window.require) {
        try {
            const { dialog, getCurrentWindow } = window.require('@electron/remote');
            const result = await dialog.showOpenDialog(getCurrentWindow(), {
                title: title,
                properties: ['openFile'],
                filters: [{ name: '媒体文件', extensions: extensions }]
            });
            if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                return result.filePaths[0];
            }
        } catch (e) {
            console.warn('remote dialog failed', e);
        }
    }
    // Web Fallback
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = extensions.map(ext => '.' + ext).join(',');
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                resolve(file.path || file.name);
            } else {
                resolve(null);
            }
        };
        input.click();
    });
}

function _getTaskRenderOverlays(task, customOptions = {}) {
    const showOverlay = customOptions.showOverlay !== undefined
        ? customOptions.showOverlay
        : _isReelsOverlayToggleEnabled();
    const options = {
        width: _reelsState?.targetWidth || 1080,
        height: _reelsState?.targetHeight || 1920,
        forExport: true,
        ...customOptions,
    };
    if (typeof window.ReelsRenderPlan?.getCompositedOverlays === 'function') {
        const composited = window.ReelsRenderPlan.getCompositedOverlays(task, options);
        return showOverlay ? composited : composited.filter(ov => ov && ov._insertClip);
    }
    const base = showOverlay && Array.isArray(task?.overlays) ? task.overlays : [];
    const inserts = window.ReelsRenderPlan?.getInsertOverlays?.(task, options) || [];
    return [...inserts, ...base];
}

function _getTaskInsertAudio(task) {
    const override = document.getElementById('reels-export-insert-audio-override')?.checked;
    const mode = document.getElementById('reels-export-insert-audio-mode')?.value || 'keep-main';
    const configured = Number(document.getElementById('reels-export-insert-audio-volume')?.value);
    const volume = Math.max(0, Math.min(200, Number.isFinite(configured) ? configured : 0));
    return (task?.insertClips || []).map(item => override ? { ...item, audioMode: mode, volume } : item)
        .filter(item => item?.sourcePath && ['source-only', 'mix'].includes(item.audioMode));
}

// ─── 每任务插入素材 ───
// 文件夹是公共来源；实际插入的具体路径与时间码只保存在当前 task.insertClips。
window.reelsChooseInsertMediaFolder = async function() {
    const task = _getSelectedTask();
    if (!task) { if (typeof showToast === 'function') showToast('请先选择一条任务', 'warning'); return; }
    return window.reelsSetInsertFolderForTasks([task]);
};
async function _getInsertMediaSourceDuration(path, sourceType) {
    if (sourceType === 'image' || sourceType === 'gif' || !window.electronAPI?.getMediaDuration) return 0;
    try {
        const duration = Number(await window.electronAPI.getMediaDuration(path));
        return Number.isFinite(duration) && duration > 0 ? duration : 0;
    } catch (_) {
        return 0;
    }
}
// 单次临时 B-Roll：不依赖素材库，也不会改写任务的公共素材文件夹。
window.reelsInsertSingleMediaAtPlayhead = async function() {
    const task = _getSelectedTask();
    if (!task || !window.ReelsRenderPlan) {
        if (typeof showToast === 'function') showToast('请先选择一条任务', 'warning');
        return;
    }
    const selected = await _pickSingleFile('选择要临时插入的素材', [
        'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'gif', 'png', 'jpg', 'jpeg', 'webp'
    ]);
    if (!selected) return;
    const playhead = _reelsState.timelineEditor?._playheadPos || 0;
    const sourceType = _getInsertMediaSourceType(selected);
    window.ReelsRenderPlan.addInsertClip(task, {
        sourcePath: selected,
        sourceType,
        sourceDuration: await _getInsertMediaSourceDuration(selected, sourceType),
        timelineStart: playhead,
    });
    _updateTimelineForTask(task);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    if (typeof showToast === 'function') showToast('已临时插入到当前播放头，可在“插入素材”轨拖动或裁切', 'success');
};
window.reelsSetInsertFolderForTasks = async function(tasks = []) {
    if (!tasks.length) return;
    const folder = await window.electronAPI?.selectDirectory?.();
    if (!folder) return;
    const entries = await window.electronAPI?.scanDirectory?.(folder) || [];
    const files = entries.filter(item => !item.isDirectory && /\.(mp4|mov|mkv|webm|avi|m4v|gif|png|jpe?g|webp)$/i.test(item.name));
    if (!files.length) { if (typeof showToast === 'function') showToast('该文件夹没有可用的视频、图片或 GIF', 'warning'); return; }
    tasks.forEach(task => { task.insertMediaFolder = folder; task.insertMediaFiles = files.map(item => item.path); });
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    if (typeof showToast === 'function') showToast(`已为 ${tasks.length} 条任务加载 ${files.length} 个插入素材`, 'success', 4000);
};

window.reelsInsertMediaAtPlayhead = async function() {
    const task = _getSelectedTask();
    if (!task || !window.ReelsRenderPlan) { if (typeof showToast === 'function') showToast('请先选择一条任务', 'warning'); return; }
    const files = Array.isArray(task.insertMediaFiles) ? task.insertMediaFiles : [];
    if (!files.length) {
        await window.reelsChooseInsertMediaFolder();
        if (!Array.isArray(task.insertMediaFiles) || !task.insertMediaFiles.length) return;
    }
    const selected = await _chooseInsertMediaFromFolder(task);
    if (!selected) return;
    const playhead = _reelsState.timelineEditor?._playheadPos || 0;
    const sourceType = _getInsertMediaSourceType(selected);
    window.ReelsRenderPlan.addInsertClip(task, {
        sourcePath: selected,
        sourceType,
        sourceDuration: await _getInsertMediaSourceDuration(selected, sourceType),
        timelineStart: playhead,
    });
    _updateTimelineForTask(task);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    if (typeof showToast === 'function') showToast('已插入到当前播放头，可在“插入素材”轨拖动或裁切', 'success');
};

// 只从 FFmpeg 找到的静音区间取点；不会在说话中间随机切画面。
window.reelsInsertAtSilences = async function(options = {}) {
    const task = options.task || _getSelectedTask();
    const files = task?.insertMediaFiles || [];
    const mediaPath = task?.audioPath || task?.voicePath || task?.bgPath || task?.videoPath;
    if (!task || !mediaPath) { if (typeof showToast === 'function') showToast('当前任务缺少可分析的音视频', 'warning'); return; }
    if (!files.length) { await window.reelsChooseInsertMediaFolder(); if (!(task.insertMediaFiles || []).length) return; }
    if (!window.electronAPI?.reelsDetectSilence) { if (typeof showToast === 'function') showToast('当前版本未加载停顿检测服务', 'error'); return; }
    const requested = options.count ?? await _showInputDialog('每条任务插入几个素材？', '例如：3', '3');
    if (requested == null) return;
    const count = Math.max(1, Math.min(12, Number(requested) || 3));
    if (options.mode === 'regenerate') task.insertClips = (task.insertClips || []).filter(item => item.generatedBy !== 'batch-silence' || item.locked);
    if (options.mode === 'reset') task.insertClips = [];
    try {
        if (typeof showToast === 'function') showToast('正在本地分析停顿点…', 'info');
        const silences = await window.electronAPI.reelsDetectSilence({ filePath: mediaPath, noiseDb: -35, minDuration: .35 });
        const duration = Math.max(_getAudioDuration(task), _getVideoDuration(task), Number(task.duration) || 0, task.customDuration || 0, 1);
        const candidates = (silences || []).filter(point => {
            const t = Number(point?.start);
            return Number.isFinite(t) && t >= 3 && t <= duration - 3;
        });
        // 任务已有片段与新片段之间最少 5 秒，避免连续闪切。
        const used = (task.insertClips || []).map(item => Number(item.timelineStart) || 0);
        const selected = [];
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        for (const point of candidates) {
            const time = Number(point.start);
            if (selected.length >= count) break;
            if ([...used, ...selected].every(prev => {
                const prevTime = typeof prev === 'object' ? Number(prev.start) : Number(prev);
                return Math.abs(prevTime - time) >= 5;
            })) selected.push(point);
        }
        if (!selected.length) { if (typeof showToast === 'function') showToast('没有找到适合插入的停顿点；可降低最短停顿阈值后重试', 'warning'); return; }
        const durationRule = options.durationRule || {};
        const fixedDuration = Math.max(.05, Math.min(120, Number(durationRule.fixedDuration) || 3));
        const maxDuration = Math.max(.05, Math.min(120, Number(durationRule.maxDuration) || 3));
        selected.sort((a, b) => Number(a.start) - Number(b.start)).forEach((point, index) => {
            const time = Number(point.start);
            // 自动模式严格不越过检测出的停顿尾部，避免插入画面压到说话内容。
            const silenceDuration = Math.max(.05, Number(point.end) - time || .05);
            const clipDuration = durationRule.mode === 'silence'
                ? Math.min(maxDuration, silenceDuration)
                : fixedDuration;
            const path = task.insertMediaFiles[index % task.insertMediaFiles.length];
            // 图片同样可由停顿点批量插入；它是静态画面片段，不应误当成视频。
            window.ReelsRenderPlan.addInsertClip(task, {
                sourcePath: path,
                sourceType: _getInsertMediaSourceType(path),
                timelineStart: time,
                duration: clipDuration,
                generatedBy: 'batch-silence'
            });
        });
        if (task === _getSelectedTask()) _updateTimelineForTask(task);
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
        if (typeof showToast === 'function') showToast(`已在 ${selected.length} 个停顿点插入素材；可逐段在时间线调整`, 'success');
    } catch (error) {
        console.error('[InsertMedia] silence detection failed', error);
        if (typeof showToast === 'function') showToast(`停顿检测失败：${error.message}`, 'error');
    }
};

window.reelsBatchInsertAtSilences = async function(options = {}) {
    const selected = window.reelsGetSelectedBatchTasks?.() || [];
    const targets = selected.length ? selected : (_getSelectedTask() ? [_getSelectedTask()] : []);
    if (!targets.length) { if (typeof showToast === 'function') showToast('请先在批量表格勾选任务', 'warning'); return; }
    const requested = await _showInputDialog(`为 ${targets.length} 条任务各插入几个素材？`, '例如：3', '3');
    if (requested == null) return;
    const count = Math.max(1, Math.min(12, Number(requested) || 3));
    let completed = 0;
    for (const task of targets) {
        try { await window.reelsInsertAtSilences({ task, count, durationRule: options.durationRule }); completed++; } catch (_) { /* 单条失败不阻断批次 */ }
    }
    if (_getSelectedTask()) _updateTimelineForTask(_getSelectedTask());
    if (typeof showToast === 'function') showToast(`停顿插入完成：${completed}/${targets.length} 条任务`, completed === targets.length ? 'success' : 'warning');
};

function _getInsertMediaSourceType(path = '') {
    if (/\.(png|jpe?g|webp)$/i.test(path)) return 'image';
    if (/\.gif$/i.test(path)) return 'gif';
    return 'video';
}

async function _chooseInsertMediaFromFolder(task) {
    const files = Array.isArray(task?.insertMediaFiles) ? task.insertMediaFiles : [];
    if (!files.length) return null;
    return new Promise(resolve => {
        const modal = document.createElement('div');
        Object.assign(modal.style, { position: 'fixed', inset: '0', zIndex: '999999', background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' });
        const panel = document.createElement('div');
        Object.assign(panel.style, { width: 'min(720px,90vw)', maxHeight: '70vh', overflow: 'auto', padding: '16px', borderRadius: '10px', background: '#1d1d25', border: '1px solid #4b5563', color: '#f3f4f6' });
        panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><div><b>选择插入素材</b><div style="font-size:11px;color:#9ca3af;margin-top:3px">图片显示缩略图，视频显示首帧</div></div><button style="cursor:pointer">取消</button></div>';
        panel.querySelector('button').onclick = () => { modal.remove(); resolve(null); };
        const list = document.createElement('div');
        Object.assign(list.style, { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: '8px' });
        const toPreviewUrl = path => window.electronAPI?.toFileUrl?.(path) || normalizeFilePath(path);
        files.forEach(path => {
            const button = document.createElement('button');
            button.title = path;
            Object.assign(button.style, { minHeight: '138px', padding: '6px', cursor: 'pointer', overflow: 'hidden', color: '#d1fae5', background: '#16352e', border: '1px solid #2d6a55', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '6px', textAlign: 'left' });
            const preview = document.createElement('div');
            Object.assign(preview.style, { height: '92px', borderRadius: '4px', overflow: 'hidden', background: '#0b1714', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#86efac', fontSize: '28px', flexShrink: '0' });
            const sourceType = _getInsertMediaSourceType(path);
            const fallback = sourceType === 'image' ? '🖼️' : (sourceType === 'gif' ? 'GIF' : '🎬');
            const showFallback = () => { preview.textContent = fallback; };
            const previewUrl = toPreviewUrl(path);
            if (sourceType === 'image' || sourceType === 'gif') {
                const image = document.createElement('img');
                image.src = previewUrl;
                image.alt = '';
                image.loading = 'lazy';
                Object.assign(image.style, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' });
                image.onerror = showFallback;
                preview.appendChild(image);
            } else {
                const video = document.createElement('video');
                video.src = previewUrl;
                video.muted = true;
                video.playsInline = true;
                video.preload = 'metadata';
                Object.assign(video.style, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' });
                video.onloadedmetadata = () => { try { video.currentTime = Math.min(0.1, Math.max(0, video.duration / 2)); } catch (_) {} };
                video.onloadeddata = () => { video.style.visibility = 'visible'; };
                video.onerror = showFallback;
                preview.appendChild(video);
            }
            const name = document.createElement('span');
            name.textContent = String(path).split(/[\\/]/).pop();
            Object.assign(name.style, { width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px', lineHeight: '1.25' });
            button.append(preview, name);
            button.onclick = () => { modal.remove(); resolve(path); };
            list.appendChild(button);
        });
        panel.appendChild(list); modal.appendChild(panel); document.body.appendChild(modal);
    });
}

function _hideInsertClipInspector() {
    document.getElementById('reels-insert-clip-inspector')?.remove();
}

function _showInsertClipInspector(editorClip) {
    _hideInsertClipInspector();
    const task = _getSelectedTask();
    const item = (task?.insertClips || []).find(value => value.id === editorClip._timelineClipId || value.id === editorClip._insertId)
        || (task?.insertClips || []).find(value => Math.abs((value.timelineStart || 0) - (editorClip.start || 0)) < .01);
    if (!task || !item) return;

    const panel = document.createElement('div');
    panel.id = 'reels-insert-clip-inspector';
    Object.assign(panel.style, {
        position: 'absolute',
        right: '16px',
        bottom: '60px',
        zIndex: '100',
        width: '320px',
        maxHeight: '80vh',
        overflowY: 'auto',
        padding: '14px',
        borderRadius: '12px',
        background: 'rgba(18, 22, 28, 0.96)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(16, 185, 129, 0.7)',
        color: '#f3f4f6',
        fontSize: '12px',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.65), 0 0 20px rgba(16, 185, 129, 0.15)',
        userSelect: 'none',
    });

    const transform = item.transform || (item.transform = { x: 0, y: 0, scale: 100, rotation: 0, opacity: 100 });
    if (!item.transitionIn) item.transitionIn = { type: 'fade', duration: 0.35 };
    if (!item.transitionOut) item.transitionOut = { type: 'fade', duration: 0.35 };
    const isImage = item.sourceType === 'image' || /\.(png|jpe?g|webp)$/i.test(item.sourcePath || '');
    const filename = (item.sourcePath || '').split(/[/\\]/).pop() || '素材片段';
    const shownDuration = Math.max(.05, Number(item.duration) || 1.5);
    const sourceDuration = Math.max(0, Number(item.sourceDuration) || 0);
    const loopCount = sourceDuration > .05 ? Math.ceil(shownDuration / sourceDuration) : 0;
    const durationInfo = isImage
        ? `图片显示 ${shownDuration.toFixed(2)} 秒`
        : (sourceDuration > .05
            ? `显示 ${shownDuration.toFixed(2)} 秒 / 原始 ${sourceDuration.toFixed(2)} 秒${loopCount > 1 ? `（循环 ${loopCount} 轮）` : ''}`
            : `显示 ${shownDuration.toFixed(2)} 秒（原始时长读取中/不可用）`);
    const canvasW = _reelsState?.targetWidth || 1080;
    const canvasH = _reelsState?.targetHeight || 1920;
    const isPip = item.mode === 'pip' || item.mode === 'overlay';
    const baseW = transform.w != null ? Number(transform.w) : (isPip ? Math.round(canvasW * 0.38) : canvasW);
    const baseH = transform.h != null ? Number(transform.h) : (isPip ? Math.round(canvasH * 0.28) : canvasH);
    const curX = transform.x != null ? Number(transform.x) : (isPip ? canvasW - baseW - 48 : 0);
    const curY = transform.y != null ? Number(transform.y) : (isPip ? canvasH - baseH - 160 : 0);
    const transInType = item.transitionIn?.type !== undefined ? item.transitionIn.type : 'fade';
    const transInDur = item.transitionIn?.duration != null ? Number(item.transitionIn.duration) : 0.35;
    const transOutType = item.transitionOut?.type !== undefined ? item.transitionOut.type : 'fade';
    const transOutDur = item.transitionOut?.duration != null ? Number(item.transitionOut.duration) : 0.35;

    const safeFilename = String(filename || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:8px">
        <div style="font-weight:700;color:#6ee7b7;display:flex;align-items:center;gap:6px">
          <span>🎬 插入素材与画中画</span>
          <span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(16,185,129,0.2);color:#a7f3d0;border:1px solid rgba(16,185,129,0.35);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${safeFilename}">${safeFilename}</span>
        </div>
        <button id="reels-insert-close-btn" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;border-radius:4px">✕</button>
      </div>
      <div style="margin:-3px 0 10px;padding:6px 8px;border-radius:6px;background:rgba(16,185,129,.10);border:1px solid rgba(16,185,129,.25);font-size:11px;color:#a7f3d0">⏱ ${durationInfo}</div>

      <!-- 模式与音量 -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        <div>
          <label style="display:block;font-size:11px;color:#9ca3af;margin-bottom:3px">显示模式</label>
          <select data-key="mode" style="width:100%;padding:4px 6px;border-radius:6px;background:#1e2430;border:1px solid #374151;color:#e5e7eb;font-size:11px">
            <option value="pip" ${item.mode !== 'replace-video-keep-main-audio' ? 'selected' : ''}>画中画 / 画面叠层</option>
            <option value="replace-video-keep-main-audio" ${item.mode === 'replace-video-keep-main-audio' ? 'selected' : ''}>全屏替换背景 (切镜)</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:11px;color:#9ca3af;margin-bottom:3px">音量 (${item.volume ?? 0}%)</label>
          <input data-key="volume" type="range" min="0" max="200" value="${item.volume ?? 0}" style="width:100%;accent-color:#10b981">
        </div>
      </div>

      <!-- 9 宫格快捷对齐 -->
      <div style="margin-bottom:12px;background:rgba(0,0,0,0.25);padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.05)">
        <div style="font-size:11px;color:#9ca3af;margin-bottom:6px;display:flex;justify-content:space-between">
          <span>快捷 9 宫格对齐</span>
          <span style="color:#6b7280;font-size:10px">画布 ${canvasW}×${canvasH}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-width:140px;margin:0 auto">
          <button data-align="top-left" class="reels-align-btn" title="左上" style="padding:4px 0;background:#2d3748;border:1px solid #4a5568;border-radius:4px;color:#cbd5e1;cursor:pointer;font-size:11px">↖</button>
          <button data-align="top-center" class="reels-align-btn" title="中上" style="padding:4px 0;background:#2d3748;border:1px solid #4a5568;border-radius:4px;color:#cbd5e1;cursor:pointer;font-size:11px">⬆</button>
          <button data-align="top-right" class="reels-align-btn" title="右上" style="padding:4px 0;background:#2d3748;border:1px solid #4a5568;border-radius:4px;color:#cbd5e1;cursor:pointer;font-size:11px">↗</button>
          <button data-align="center-left" class="reels-align-btn" title="左中" style="padding:4px 0;background:#2d3748;border:1px solid #4a5568;border-radius:4px;color:#cbd5e1;cursor:pointer;font-size:11px">⬅</button>
          <button data-align="center" class="reels-align-btn" title="居中" style="padding:4px 0;background:#059669;border:1px solid #10b981;border-radius:4px;color:#fff;cursor:pointer;font-size:11px">┼</button>
          <button data-align="center-right" class="reels-align-btn" title="右中" style="padding:4px 0;background:#2d3748;border:1px solid #4a5568;border-radius:4px;color:#cbd5e1;cursor:pointer;font-size:11px">➡</button>
          <button data-align="bottom-left" class="reels-align-btn" title="左下" style="padding:4px 0;background:#2d3748;border:1px solid #4a5568;border-radius:4px;color:#cbd5e1;cursor:pointer;font-size:11px">↙</button>
          <button data-align="bottom-center" class="reels-align-btn" title="中下" style="padding:4px 0;background:#2d3748;border:1px solid #4a5568;border-radius:4px;color:#cbd5e1;cursor:pointer;font-size:11px">⬇</button>
          <button data-align="bottom-right" class="reels-align-btn" title="右下" style="padding:4px 0;background:#2d3748;border:1px solid #4a5568;border-radius:4px;color:#cbd5e1;cursor:pointer;font-size:11px">↘</button>
        </div>
      </div>

      <!-- 位置精确调整 -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        <div>
          <label style="display:flex;justify-content:space-between;font-size:11px;color:#9ca3af;margin-bottom:3px">
            <span>X 坐标 (px)</span>
          </label>
          <input data-t="x" type="number" value="${Math.round(curX)}" style="width:100%;padding:4px 6px;border-radius:6px;background:#1e2430;border:1px solid #374151;color:#e5e7eb;font-size:11px">
        </div>
        <div>
          <label style="display:flex;justify-content:space-between;font-size:11px;color:#9ca3af;margin-bottom:3px">
            <span>Y 坐标 (px)</span>
          </label>
          <input data-t="y" type="number" value="${Math.round(curY)}" style="width:100%;padding:4px 6px;border-radius:6px;background:#1e2430;border:1px solid #374151;color:#e5e7eb;font-size:11px">
        </div>
      </div>

      <!-- 缩放与旋转 -->
      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
          <span style="font-size:11px;color:#9ca3af">缩放比例</span>
          <div style="display:flex;align-items:center;gap:4px">
            <button data-scale-val="50" style="background:#2d3748;border:none;border-radius:3px;color:#94a3b8;padding:1px 4px;font-size:9px;cursor:pointer">50%</button>
            <button data-scale-val="100" style="background:#2d3748;border:none;border-radius:3px;color:#94a3b8;padding:1px 4px;font-size:9px;cursor:pointer">100%</button>
            <button data-scale-val="150" style="background:#2d3748;border:none;border-radius:3px;color:#94a3b8;padding:1px 4px;font-size:9px;cursor:pointer">150%</button>
            <span id="reels-scale-val-txt" style="color:#6ee7b7;font-weight:600;min-width:34px;text-align:right">${transform.scale ?? 100}%</span>
          </div>
        </div>
        <input data-t="scale" type="range" min="10" max="300" value="${transform.scale ?? 100}" style="width:100%;accent-color:#10b981">
      </div>

      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
          <span style="font-size:11px;color:#9ca3af">旋转角度</span>
          <div style="display:flex;align-items:center;gap:4px">
            <button data-rot-val="0" style="background:#2d3748;border:none;border-radius:3px;color:#94a3b8;padding:1px 4px;font-size:9px;cursor:pointer">0°</button>
            <button data-rot-val="90" style="background:#2d3748;border:none;border-radius:3px;color:#94a3b8;padding:1px 4px;font-size:9px;cursor:pointer">90°</button>
            <button data-rot-val="180" style="background:#2d3748;border:none;border-radius:3px;color:#94a3b8;padding:1px 4px;font-size:9px;cursor:pointer">180°</button>
            <button data-rot-val="-90" style="background:#2d3748;border:none;border-radius:3px;color:#94a3b8;padding:1px 4px;font-size:9px;cursor:pointer">-90°</button>
            <span id="reels-rot-val-txt" style="color:#6ee7b7;font-weight:600;min-width:30px;text-align:right">${transform.rotation ?? 0}°</span>
          </div>
        </div>
        <input data-t="rotation" type="range" min="-180" max="180" value="${transform.rotation ?? 0}" style="width:100%;accent-color:#10b981">
      </div>

      <!-- 翻转与透明度 -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div>
          <label style="display:block;font-size:11px;color:#9ca3af;margin-bottom:3px">不透明度 (${transform.opacity ?? 100}%)</label>
          <input data-t="opacity" type="range" min="0" max="100" value="${transform.opacity ?? 100}" style="width:100%;accent-color:#10b981">
        </div>
        <div style="display:flex;align-items:flex-end;gap:4px;padding-bottom:2px">
          <button id="reels-fliph-btn" style="flex:1;padding:5px 0;background:${transform.flipH ? '#059669' : '#2d3748'};border:1px solid ${transform.flipH ? '#10b981' : '#4a5568'};border-radius:6px;color:#f3f4f6;cursor:pointer;font-size:11px" title="水平镜像翻转">⇋ 水平</button>
          <button id="reels-flipv-btn" style="flex:1;padding:5px 0;background:${transform.flipV ? '#059669' : '#2d3748'};border:1px solid ${transform.flipV ? '#10b981' : '#4a5568'};border-radius:6px;color:#f3f4f6;cursor:pointer;font-size:11px" title="垂直镜像翻转">⥮ 垂直</button>
        </div>
      </div>

      <!-- 入场 / 出场转场动画 -->
      <div style="background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-radius:8px;padding:10px;margin-bottom:12px">
        <div style="font-weight:600;color:#a7f3d0;margin-bottom:8px;font-size:11px;display:flex;align-items:center;gap:4px">
          <span>✨ 转场动画 (淡入淡出 / 滑入 / 弹出)</span>
        </div>
        
        <!-- 入场动画 -->
        <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:6px;margin-bottom:6px;align-items:center">
          <div>
            <label style="display:block;font-size:10px;color:#9ca3af;margin-bottom:2px">入场动画</label>
            <select data-anim="in-type" style="width:100%;padding:3px 5px;border-radius:4px;background:#1e2430;border:1px solid #374151;color:#e5e7eb;font-size:11px">
              <option value="none" ${transInType === 'none' ? 'selected' : ''}>无动画</option>
              <option value="fade" ${transInType === 'fade' ? 'selected' : ''}>淡入 (Fade In)</option>
              <option value="pop" ${transInType === 'pop' ? 'selected' : ''}>弹出 (Pop)</option>
              <option value="slide_up" ${transInType === 'slide_up' ? 'selected' : ''}>向上滑入</option>
              <option value="slide_down" ${transInType === 'slide_down' ? 'selected' : ''}>向下滑入</option>
              <option value="slide_left" ${transInType === 'slide_left' ? 'selected' : ''}>向左滑入</option>
              <option value="slide_right" ${transInType === 'slide_right' ? 'selected' : ''}>向右滑入</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-size:10px;color:#9ca3af;margin-bottom:2px">入场时长 (s)</label>
            <input data-anim="in-dur" type="number" min="0.05" max="2" step="0.05" value="${transInDur}" style="width:100%;padding:3px 5px;border-radius:4px;background:#1e2430;border:1px solid #374151;color:#e5e7eb;font-size:11px">
          </div>
        </div>

        <!-- 出场动画 -->
        <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:6px;align-items:center">
          <div>
            <label style="display:block;font-size:10px;color:#9ca3af;margin-bottom:2px">出场动画</label>
            <select data-anim="out-type" style="width:100%;padding:3px 5px;border-radius:4px;background:#1e2430;border:1px solid #374151;color:#e5e7eb;font-size:11px">
              <option value="none" ${transOutType === 'none' ? 'selected' : ''}>无动画</option>
              <option value="fade" ${transOutType === 'fade' ? 'selected' : ''}>淡出 (Fade Out)</option>
              <option value="pop" ${transOutType === 'pop' ? 'selected' : ''}>弹缩消失 (Pop)</option>
              <option value="slide_up" ${transOutType === 'slide_up' ? 'selected' : ''}>向上滑出</option>
              <option value="slide_down" ${transOutType === 'slide_down' ? 'selected' : ''}>向下滑出</option>
              <option value="slide_left" ${transOutType === 'slide_left' ? 'selected' : ''}>向左滑出</option>
              <option value="slide_right" ${transOutType === 'slide_right' ? 'selected' : ''}>向右滑出</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-size:10px;color:#9ca3af;margin-bottom:2px">出场时长 (s)</label>
            <input data-anim="out-dur" type="number" min="0.05" max="2" step="0.05" value="${transOutDur}" style="width:100%;padding:3px 5px;border-radius:4px;background:#1e2430;border:1px solid #374151;color:#e5e7eb;font-size:11px">
          </div>
        </div>
      </div>

      <!-- 时间与裁切 -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px">
        <div>
          <label style="display:block;font-size:10px;color:#9ca3af;margin-bottom:2px">持续时长 (s)</label>
          <input data-d="duration" type="number" min="0.05" max="120" step="0.1" value="${item.duration ?? 1.5}" style="width:100%;padding:3px 5px;border-radius:4px;background:#1e2430;border:1px solid #374151;color:#e5e7eb;font-size:11px">
        </div>
        <div>
          <label style="display:block;font-size:10px;color:#9ca3af;margin-bottom:2px">源入点 (s)</label>
          <input data-s="sourceTrimStart" type="number" min="0" step="0.1" value="${item.sourceTrimStart ?? 0}" style="width:100%;padding:3px 5px;border-radius:4px;background:#1e2430;border:1px solid #374151;color:#e5e7eb;font-size:11px">
        </div>
        <div>
          <label style="display:block;font-size:10px;color:#9ca3af;margin-bottom:2px">源出点 (s)</label>
          <input data-s="sourceTrimEnd" type="number" min="0" step="0.1" value="${item.sourceTrimEnd ?? ((item.sourceTrimStart || 0) + (item.duration || 1.5))}" style="width:100%;padding:3px 5px;border-radius:4px;background:#1e2430;border:1px solid #374151;color:#e5e7eb;font-size:11px">
        </div>
      </div>

      <!-- 底部删除按钮 -->
      <div style="display:flex;justify-content:flex-end">
        <button id="reels-insert-delete-btn" style="padding:4px 10px;background:#ef4444;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:11px;font-weight:600">🗑️ 删除此素材片段</button>
      </div>
    `;

    // ── 交互事件绑定 ──
    const closeBtn = panel.querySelector('#reels-insert-close-btn');
    if (closeBtn) closeBtn.onclick = _hideInsertClipInspector;

    const syncLiveUpdate = () => {
        window.ReelsRenderPlan?.ensureTimeline(task);
        _updateTimelineForTask(task);
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
        if (typeof window.ReelsPreviewV2?.render === 'function') window.ReelsPreviewV2.render();
    };

    // 快捷 9 宫格对齐处理
    panel.querySelectorAll('.reels-align-btn').forEach(btn => {
        btn.onclick = () => {
            const align = btn.dataset.align;
            const w = baseW * ((transform.scale || 100) / 100);
            const h = baseH * ((transform.scale || 100) / 100);
            const padX = 48, padY = 48, bottomPadY = 160;
            let targetX = curX, targetY = curY;

            if (align === 'top-left') { targetX = padX; targetY = padY; }
            else if (align === 'top-center') { targetX = (canvasW - w) / 2; targetY = padY; }
            else if (align === 'top-right') { targetX = canvasW - w - padX; targetY = padY; }
            else if (align === 'center-left') { targetX = padX; targetY = (canvasH - h) / 2; }
            else if (align === 'center') { targetX = (canvasW - w) / 2; targetY = (canvasH - h) / 2; }
            else if (align === 'center-right') { targetX = canvasW - w - padX; targetY = (canvasH - h) / 2; }
            else if (align === 'bottom-left') { targetX = padX; targetY = canvasH - h - bottomPadY; }
            else if (align === 'bottom-center') { targetX = (canvasW - w) / 2; targetY = canvasH - h - bottomPadY; }
            else if (align === 'bottom-right') { targetX = canvasW - w - padX; targetY = canvasH - h - bottomPadY; }

            transform.x = Math.round(targetX);
            transform.y = Math.round(targetY);
            const xInput = panel.querySelector('[data-t="x"]');
            const yInput = panel.querySelector('[data-t="y"]');
            if (xInput) xInput.value = transform.x;
            if (yInput) yInput.value = transform.y;
            syncLiveUpdate();
        };
    });

    // 快捷缩放与旋转按钮
    panel.querySelectorAll('[data-scale-val]').forEach(btn => {
        btn.onclick = () => {
            const val = Number(btn.dataset.scaleVal);
            transform.scale = val;
            const scaleInput = panel.querySelector('[data-t="scale"]');
            if (scaleInput) scaleInput.value = val;
            const txt = panel.querySelector('#reels-scale-val-txt');
            if (txt) txt.textContent = `${val}%`;
            syncLiveUpdate();
        };
    });

    panel.querySelectorAll('[data-rot-val]').forEach(btn => {
        btn.onclick = () => {
            const val = Number(btn.dataset.rotVal);
            transform.rotation = val;
            const rotInput = panel.querySelector('[data-t="rotation"]');
            if (rotInput) rotInput.value = val;
            const txt = panel.querySelector('#reels-rot-val-txt');
            if (txt) txt.textContent = `${val}°`;
            syncLiveUpdate();
        };
    });

    // 水平/垂直翻转
    const flipHBtn = panel.querySelector('#reels-fliph-btn');
    if (flipHBtn) {
        flipHBtn.onclick = () => {
            transform.flipH = !transform.flipH;
            flipHBtn.style.background = transform.flipH ? '#4f46e5' : '#2d3748';
            flipHBtn.style.borderColor = transform.flipH ? '#6366f1' : '#4a5568';
            syncLiveUpdate();
        };
    }
    const flipVBtn = panel.querySelector('#reels-flipv-btn');
    if (flipVBtn) {
        flipVBtn.onclick = () => {
            transform.flipV = !transform.flipV;
            flipVBtn.style.background = transform.flipV ? '#4f46e5' : '#2d3748';
            flipVBtn.style.borderColor = transform.flipV ? '#6366f1' : '#4a5568';
            syncLiveUpdate();
        };
    }

    // 转场动画设置
    const inTypeSelect = panel.querySelector('[data-anim="in-type"]');
    const inDurInput = panel.querySelector('[data-anim="in-dur"]');
    const outTypeSelect = panel.querySelector('[data-anim="out-type"]');
    const outDurInput = panel.querySelector('[data-anim="out-dur"]');

    const updateAnims = () => {
        const inType = inTypeSelect?.value || 'none';
        const inDur = Math.max(0.05, Number(inDurInput?.value) || 0.3);
        const outType = outTypeSelect?.value || 'none';
        const outDur = Math.max(0.05, Number(outDurInput?.value) || 0.3);
        item.transitionIn = { type: inType, duration: inDur };
        item.transitionOut = { type: outType, duration: outDur };
        syncLiveUpdate();
    };
    inTypeSelect?.addEventListener('change', updateAnims);
    inDurInput?.addEventListener('input', updateAnims);
    outTypeSelect?.addEventListener('change', updateAnims);
    outDurInput?.addEventListener('input', updateAnims);

    // 通用输入框与滑块实时监听 (input + change)
    panel.querySelectorAll('input,select').forEach(input => {
        const handler = () => {
            if (input.dataset.key) {
                item[input.dataset.key] = input.dataset.key === 'volume' ? Number(input.value) : input.value;
            }
            if (input.dataset.t) {
                transform[input.dataset.t] = Number(input.value);
                if (input.dataset.t === 'scale') {
                    const txt = panel.querySelector('#reels-scale-val-txt');
                    if (txt) txt.textContent = `${input.value}%`;
                } else if (input.dataset.t === 'rotation') {
                    const txt = panel.querySelector('#reels-rot-val-txt');
                    if (txt) txt.textContent = `${input.value}°`;
                }
            }
            if (input.dataset.d) {
                item.duration = Math.max(0.05, Math.min(120, Number(input.value) || 1.5));
                item.sourceTrimEnd = Math.max(0, Number(item.sourceTrimStart) || 0) + item.duration;
            }
            if (input.dataset.s) {
                item[input.dataset.s] = Math.max(0, Number(input.value) || 0);
                if (input.dataset.s === 'sourceTrimEnd') {
                    item.duration = Math.max(0.05, item.sourceTrimEnd - (Number(item.sourceTrimStart) || 0));
                } else {
                    item.sourceTrimEnd = (Number(item.sourceTrimStart) || 0) + Math.max(0.05, Number(item.duration) || 1.5);
                }
            }
            syncLiveUpdate();
        };
        input.addEventListener('input', handler);
        input.addEventListener('change', handler);
    });

    // 删除按钮
    const delBtn = panel.querySelector('#reels-insert-delete-btn');
    if (delBtn) {
        delBtn.onclick = () => {
            if (confirm('确定要删除此插入素材片段吗？')) {
                task.insertClips = (task.insertClips || []).filter(c => c !== item && c.id !== item.id);
                _hideInsertClipInspector();
                syncLiveUpdate();
            }
        };
    }

    document.getElementById('batch-reels-panel')?.appendChild(panel);
}

// ─── 背景与内容视频双向同步与全队列批量调节逻辑 ───
let _bgQueueSyncInitDone = false;
let _bgQueueRenderTableDebounceTimer = null;

function _isBgQueueSyncEnabled() {
    const chk = document.getElementById('reels-bg-sync-all-queue');
    if (chk) return !!chk.checked;
    try { return localStorage.getItem('reels_bg_sync_all_queue') === 'true'; } catch (_) { return false; }
}

function _getBgQueueScope() {
    const sel = document.getElementById('reels-bg-queue-scope');
    if (sel && sel.value) return sel.value;
    try { return localStorage.getItem('reels_bg_queue_scope') || 'all'; } catch (_) { return 'all'; }
}

function _getBgQueueTargetTasks() {
    const allTasks = Array.isArray(_reelsState?.tasks) ? _reelsState.tasks : [];
    if (!allTasks.length) return [];
    const scope = _getBgQueueScope();
    if (scope === 'checked' && typeof window.reelsGetSelectedBatchTasks === 'function') {
        const checkedTasks = window.reelsGetSelectedBatchTasks();
        if (Array.isArray(checkedTasks) && checkedTasks.length > 0) {
            const currentTask = _reelsState.tasks[_reelsState.selectedIdx];
            if (currentTask && !checkedTasks.includes(currentTask)) {
                return [currentTask, ...checkedTasks];
            }
            return checkedTasks;
        }
    }
    return allTasks;
}

function _refreshBgQueueSyncBadge() {
    const chk = document.getElementById('reels-bg-sync-all-queue');
    const scopeEl = document.getElementById('reels-bg-queue-scope');
    const badge = document.getElementById('reels-bg-sync-all-badge');
    if (!_bgQueueSyncInitDone && (chk || scopeEl)) {
        try {
            const savedSync = localStorage.getItem('reels_bg_sync_all_queue');
            if (chk && savedSync !== null) chk.checked = savedSync === 'true';
            const savedScope = localStorage.getItem('reels_bg_queue_scope');
            if (scopeEl && savedScope) scopeEl.value = savedScope;
        } catch (_) {}
        _bgQueueSyncInitDone = true;
    }
    if (!badge) return;
    const enabled = _isBgQueueSyncEnabled();
    const targetCount = _getBgQueueTargetTasks().length;
    if (enabled) {
        badge.textContent = `🔥 实时同步 (${targetCount}个任务)`;
        badge.style.background = 'rgba(37, 99, 235, 0.35)';
        badge.style.color = '#93c5fd';
        badge.style.border = '1px solid rgba(96, 165, 250, 0.5)';
    } else {
        badge.textContent = '仅当前任务';
        badge.style.background = 'rgba(148, 163, 184, 0.2)';
        badge.style.color = '#cbd5e1';
        badge.style.border = 'none';
    }
}

function _copyBgParamsToTask(sourceTask, targetTask) {
    if (!sourceTask || !targetTask || sourceTask === targetTask) return;
    targetTask.bgScale = sourceTask.bgScale != null ? sourceTask.bgScale : 100;
    targetTask.bgRotation = sourceTask.bgRotation != null ? sourceTask.bgRotation : 0;
    targetTask.bgX = sourceTask.bgX != null ? sourceTask.bgX : 0;
    targetTask.bgY = sourceTask.bgY != null ? sourceTask.bgY : 0;
    targetTask.bgFlipH = !!sourceTask.bgFlipH;
    targetTask.bgFlipV = !!sourceTask.bgFlipV;
    targetTask.bgDurScale = sourceTask.bgDurScale != null ? sourceTask.bgDurScale : 100;
    targetTask.bgTransition = sourceTask.bgTransition || 'crossfade';
    targetTask.bgTransDur = sourceTask.bgTransDur != null ? sourceTask.bgTransDur : 0.5;
    targetTask.bgClipOrder = sourceTask.bgClipOrder || 'random';
    if (sourceTask.bgVideoVolume != null) {
        targetTask.bgVideoVolume = sourceTask.bgVideoVolume;
    } else {
        delete targetTask.bgVideoVolume;
    }
}

function _copyCvParamsToTask(sourceTask, targetTask) {
    if (!sourceTask || !targetTask || sourceTask === targetTask) return;
    targetTask.contentVideoBlurBg = !!sourceTask.contentVideoBlurBg;
    targetTask.contentVideoDirectBg = !!sourceTask.contentVideoDirectBg;
    targetTask.contentVideoBlur = sourceTask.contentVideoBlur != null ? sourceTask.contentVideoBlur : 40;
    targetTask.contentVideoBrightness = sourceTask.contentVideoBrightness != null ? sourceTask.contentVideoBrightness : 60;
    targetTask.contentVideoVolume = sourceTask.contentVideoVolume != null ? sourceTask.contentVideoVolume : 100;
    targetTask.contentVideoScale = sourceTask.contentVideoScale != null ? sourceTask.contentVideoScale : 100;
    targetTask.contentVideoFlipH = !!sourceTask.contentVideoFlipH;
    targetTask.contentVideoFlipV = !!sourceTask.contentVideoFlipV;
    targetTask.contentVideoTrimStart = sourceTask.contentVideoTrimStart != null ? sourceTask.contentVideoTrimStart : null;
    targetTask.contentVideoTrimEnd = sourceTask.contentVideoTrimEnd != null ? sourceTask.contentVideoTrimEnd : null;
    targetTask.contentVideoCrop = sourceTask.contentVideoCrop || '';
    targetTask.contentVideoX = sourceTask.contentVideoX || 'center';
    targetTask.contentVideoY = sourceTask.contentVideoY || 'center';
}

function _copyBgmParamsToTask(sourceTask, targetTask) {
    if (!sourceTask || !targetTask || sourceTask === targetTask) return;
    targetTask.bgmClipOrder = sourceTask.bgmClipOrder || 'random';
    if (sourceTask.bgmVolume != null) {
        targetTask.bgmVolume = sourceTask.bgmVolume;
    } else {
        delete targetTask.bgmVolume;
    }
}

function _flushBgQueueTableAndHistory(options = {}) {
    const immediate = options.immediate === true;
    const totalTasks = Array.isArray(_reelsState?.tasks) ? _reelsState.tasks.length : 0;
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const isRangeDragging = !immediate && totalTasks > 50 && activeEl && activeEl.tagName === 'INPUT' && activeEl.type === 'range';

    const doFlush = () => {
        if (typeof _renderBatchTable === 'function') {
            if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
            _renderBatchTable();
        }
        if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
        if (typeof _batchAutoSave === 'function') _batchAutoSave();
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    };

    if (isRangeDragging) {
        if (_bgQueueRenderTableDebounceTimer) clearTimeout(_bgQueueRenderTableDebounceTimer);
        _bgQueueRenderTableDebounceTimer = setTimeout(() => {
            _bgQueueRenderTableDebounceTimer = null;
            doFlush();
        }, 120);
    } else {
        if (_bgQueueRenderTableDebounceTimer) {
            clearTimeout(_bgQueueRenderTableDebounceTimer);
            _bgQueueRenderTableDebounceTimer = null;
        }
        doFlush();
    }
}

window._syncCvPosControlToQueueIfEnabled = function(sourceTask) {
    if (!sourceTask || !_isBgQueueSyncEnabled()) return;
    const targets = _getBgQueueTargetTasks();
    for (const t of targets) {
        if (t && t !== sourceTask) {
            t.contentVideoX = sourceTask.contentVideoX || 'center';
            t.contentVideoY = sourceTask.contentVideoY || 'center';
            t.contentVideoScale = sourceTask.contentVideoScale != null ? sourceTask.contentVideoScale : 100;
        }
    }
    _flushBgQueueTableAndHistory({ immediate: false });
};

window.reelsOnBgSyncAllQueueToggle = function(checked) {
    try { localStorage.setItem('reels_bg_sync_all_queue', checked ? 'true' : 'false'); } catch (_) {}
    _bgQueueSyncInitDone = true;
    _refreshBgQueueSyncBadge();
    if (checked) {
        window.reelsSaveBgConfigUI();
        const count = _getBgQueueTargetTasks().length;
        if (typeof showToast === 'function') {
            showToast(`🔗 已开启全队列同步调节，当前参数已同步到 ${count} 个任务`, 'success');
        }
    } else if (typeof showToast === 'function') {
        showToast('已切换为仅调节当前选中任务', 'info');
    }
};

window.reelsOnBgQueueScopeChange = function(scope) {
    try { localStorage.setItem('reels_bg_queue_scope', scope || 'all'); } catch (_) {}
    _refreshBgQueueSyncBadge();
    if (_isBgQueueSyncEnabled()) {
        window.reelsSaveBgConfigUI();
    }
};

window.reelsSyncBackgroundTabUI = function(task) {
    if (!task) return;

    const bgPathEl = document.getElementById('reels-bg-path-ui');
    if (!bgPathEl) return;

    _refreshBgQueueSyncBadge();

    // 背景模式与面板显示切换
    const bgMode = task.bgMode || 'single';
    document.getElementById('reels-bg-mode-ui').value = bgMode;
    
    const singleContainer = document.getElementById('reels-bg-single-container');
    const multiContainer = document.getElementById('reels-bg-multi-container');
    if (singleContainer) singleContainer.style.display = bgMode === 'single' ? 'flex' : 'none';
    if (multiContainer) multiContainer.style.display = bgMode === 'multi' ? 'flex' : 'none';

    // 背景单素材文件路径
    bgPathEl.value = task.bgPath || '';
    
    // 背景多素材池统计与转场设置
    const poolCount = task.bgClipPool ? task.bgClipPool.length : 0;
    const activePoolCount = Array.isArray(task.bgClipActivePool) && task.bgClipActivePool.length > 0
        ? task.bgClipActivePool.filter(p => (task.bgClipPool || []).includes(p)).length
        : poolCount;
    const poolCountEl = document.getElementById('reels-bg-pool-count');
    if (poolCountEl) poolCountEl.textContent = `已添加 ${poolCount} 个素材 · 启用 ${activePoolCount} 个`;

    const transitionSelect = document.getElementById('reels-bg-transition-ui');
    if (transitionSelect) transitionSelect.value = task.bgTransition || 'crossfade';

    const clipOrderSelect = document.getElementById('reels-bg-cliporder-ui');
    if (clipOrderSelect) clipOrderSelect.value = task.bgClipOrder || 'random';

    const transDur = task.bgTransDur != null ? task.bgTransDur : 0.5;
    const transDurRange = document.getElementById('reels-bg-transdur-range');
    const transDurNum = document.getElementById('reels-bg-transdur-num');
    if (transDurRange) transDurRange.value = transDur;
    if (transDurNum) transDurNum.value = transDur;

    // 背景缩放百分比
    const bgScale = task.bgScale != null ? task.bgScale : 100;
    document.getElementById('reels-bg-scale-num').value = bgScale;
    document.getElementById('reels-bg-scale-range').value = bgScale;

    const bgRotation = task.bgRotation != null ? task.bgRotation : 0;
    document.getElementById('reels-bg-rotate-num').value = bgRotation;
    document.getElementById('reels-bg-rotate-range').value = bgRotation;

    // 背景X偏移
    const bgX = task.bgX != null ? task.bgX : 0;
    document.getElementById('reels-bg-x-num').value = bgX;
    document.getElementById('reels-bg-x-range').value = bgX;

    // 背景Y偏移
    const bgY = task.bgY != null ? task.bgY : 0;
    document.getElementById('reels-bg-y-num').value = bgY;
    document.getElementById('reels-bg-y-range').value = bgY;

    // 背景音量
    const globalBgVol = _getGlobalBgVolumePercent();
    const hasCustomBgVol = task.bgVideoVolume != null && parseFloat(task.bgVideoVolume) !== 100;
    const bgVol = hasCustomBgVol ? task.bgVideoVolume : globalBgVol;
    const volumeRangeEl = document.getElementById('reels-bg-volume-range');
    const volumeNumEl = document.getElementById('reels-bg-volume-num');
    if (volumeRangeEl) {
        volumeRangeEl.value = bgVol;
        volumeRangeEl.dataset.isCustom = hasCustomBgVol ? 'true' : 'false';
    }
    if (volumeNumEl) {
        volumeNumEl.value = bgVol;
        volumeNumEl.dataset.isCustom = hasCustomBgVol ? 'true' : 'false';
    }

    // 背景变速
    const bgDur = task.bgDurScale != null ? task.bgDurScale : 100;
    document.getElementById('reels-bg-dur-scale-num').value = bgDur;
    document.getElementById('reels-bg-dur-scale-range').value = bgDur;

    // 内容视频文件路径与毛玻璃开关
    document.getElementById('reels-cv-path-ui').value = task.contentVideoPath || '';
    const cvBlurBg = !!task.contentVideoBlurBg;
    document.getElementById('reels-cv-blur-bg-ui').checked = cvBlurBg;
    const directBgEl = document.getElementById('reels-cv-direct-bg-ui');
    if (directBgEl) {
        directBgEl.checked = !!task.contentVideoDirectBg;
    }

    const blurParamsContainer = document.getElementById('reels-cv-blur-params-container');
    if (blurParamsContainer) {
        blurParamsContainer.style.display = cvBlurBg ? 'flex' : 'none';
    }
    const cvBlur = task.contentVideoBlur != null ? task.contentVideoBlur : 40;
    const cvBrightness = task.contentVideoBrightness != null ? task.contentVideoBrightness : 60;
    const blurRange = document.getElementById('reels-cv-blur-range');
    const blurNum = document.getElementById('reels-cv-blur-num');
    const brightRange = document.getElementById('reels-cv-brightness-range');
    const brightNum = document.getElementById('reels-cv-brightness-num');
    if (blurRange) blurRange.value = cvBlur;
    if (blurNum) blurNum.value = cvBlur;
    if (brightRange) brightRange.value = cvBrightness;
    if (brightNum) brightNum.value = cvBrightness;

    // 视频音量
    const cvVol = task.contentVideoVolume != null ? task.contentVideoVolume : 100;
    document.getElementById('reels-cv-volume-num').value = cvVol;
    document.getElementById('reels-cv-volume-range').value = cvVol;

    // 视频缩放
    const cvScale = task.contentVideoScale != null ? task.contentVideoScale : 100;
    document.getElementById('reels-cv-scale-num').value = cvScale;
    document.getElementById('reels-cv-scale-range').value = cvScale;
    const cvPosScaleEl = document.getElementById('reels-cv-pos-scale-val');
    if (cvPosScaleEl) cvPosScaleEl.value = cvScale;

    // 内容视频位置偏移 (X / Y px)
    const cvXNum = (task.contentVideoX && task.contentVideoX !== 'center') ? (parseFloat(task.contentVideoX) || 0) : 0;
    const cvYNum = (task.contentVideoY && task.contentVideoY !== 'center') ? (parseFloat(task.contentVideoY) || 0) : 0;
    const cvXNumEl = document.getElementById('reels-cv-x-num');
    const cvXRangeEl = document.getElementById('reels-cv-x-range');
    const cvYNumEl = document.getElementById('reels-cv-y-num');
    const cvYRangeEl = document.getElementById('reels-cv-y-range');
    if (cvXNumEl) cvXNumEl.value = cvXNum;
    if (cvXRangeEl) cvXRangeEl.value = Math.max(-540, Math.min(540, cvXNum));
    if (cvYNumEl) cvYNumEl.value = cvYNum;
    if (cvYRangeEl) cvYRangeEl.value = Math.max(-960, Math.min(960, cvYNum));
    const cvPosXValEl = document.getElementById('reels-cv-pos-x-val');
    const cvPosYValEl = document.getElementById('reels-cv-pos-y-val');
    if (cvPosXValEl) cvPosXValEl.value = task.contentVideoX || 'center';
    if (cvPosYValEl) cvPosYValEl.value = task.contentVideoY || 'center';

    // 视频翻转与背景翻转
    document.getElementById('reels-bg-fliph-ui').checked = !!task.bgFlipH;
    document.getElementById('reels-bg-flipv-ui').checked = !!task.bgFlipV;
    document.getElementById('reels-cv-fliph-ui').checked = !!task.contentVideoFlipH;
    document.getElementById('reels-cv-flipv-ui').checked = !!task.contentVideoFlipV;

    // 裁剪时长
    document.getElementById('reels-cv-trim-start').value = task.contentVideoTrimStart != null ? task.contentVideoTrimStart : '';
    document.getElementById('reels-cv-trim-end').value = task.contentVideoTrimEnd != null ? task.contentVideoTrimEnd : '';

    // 空间画面裁切 (Spatial Crop) - 包含文本框与滑杆的双向同步
    let cropVal = task.contentVideoCrop || '0,0,100,100';
    let parts = cropVal.split(',').map(p => parseFloat(p.trim()));
    if (parts.length !== 4 || parts.some(isNaN)) {
        parts = [0, 0, 100, 100];
    }
    const [cLeft, cTop, cWidth, cHeight] = parts;
    document.getElementById('reels-cv-crop-left').value = cLeft;
    document.getElementById('reels-cv-crop-left-range').value = cLeft;
    
    document.getElementById('reels-cv-crop-top').value = cTop;
    document.getElementById('reels-cv-crop-top-range').value = cTop;
    
    document.getElementById('reels-cv-crop-width').value = cWidth;
    document.getElementById('reels-cv-crop-width-range').value = cWidth;
    
    document.getElementById('reels-cv-crop-height').value = cHeight;
    document.getElementById('reels-cv-crop-height-range').value = cHeight;

    // 片段池拼接设置同步
    const clipPoolDir = task.clipPoolDir || '';
    const clipPoolDirEl = document.getElementById('reels-bg-clippool-dir-ui');
    if (clipPoolDirEl) {
        clipPoolDirEl.value = clipPoolDir;
    }
    
    const clipOrderEl = document.getElementById('reels-bg-clippool-order-ui');
    if (clipOrderEl) {
        clipOrderEl.value = task.clipOrder || 'name';
    }
    
    const clipStatusEl = document.getElementById('reels-bg-clippool-status-ui');
    if (clipStatusEl) {
        if (task.concatStatus === 'generating') {
            clipStatusEl.textContent = '⏳ 拼接中...';
        } else if (task.concatVideoPath) {
            const shortName = task.concatVideoPath.split(/[\\/]/).pop();
            clipStatusEl.textContent = `✅ ${shortName}`;
            clipStatusEl.title = task.concatVideoPath;
        } else {
            const clipCount = Array.isArray(task.clipPool) ? task.clipPool.length : 0;
            clipStatusEl.textContent = `${clipCount} 个片段`;
        }
    }

    // ── 配乐设置同步 ──
    const bgmMode = task.bgmMode || 'single';
    const reelsBgmModeUI = document.getElementById('reels-bgm-mode-ui');
    if (reelsBgmModeUI) reelsBgmModeUI.value = bgmMode;
    
    const bgmSingleContainer = document.getElementById('reels-bgm-single-container');
    const bgmMultiContainer = document.getElementById('reels-bgm-multi-container');
    if (bgmSingleContainer) bgmSingleContainer.style.display = bgmMode === 'single' ? 'flex' : 'none';
    if (bgmMultiContainer) bgmMultiContainer.style.display = bgmMode === 'multi' ? 'flex' : 'none';

    const bgmPathUI = document.getElementById('reels-bgm-path-ui');
    if (bgmPathUI) bgmPathUI.value = task.bgmPath || '';
    
    const bgmPool = task.bgmClipPool || [];
    const bgmPoolCount = bgmPool.length;
    const bgmActivePoolCount = Array.isArray(task.bgmClipActivePool) && task.bgmClipActivePool.length > 0
        ? task.bgmClipActivePool.filter(p => bgmPool.includes(p)).length
        : bgmPoolCount;
    const bgmPoolCountEl = document.getElementById('reels-bgm-pool-count');
    if (bgmPoolCountEl) bgmPoolCountEl.textContent = `已添加 ${bgmPoolCount} 个配乐 · 启用 ${bgmActivePoolCount} 个`;

    const bgmClipOrderUI = document.getElementById('reels-bgm-cliporder-ui');
    if (bgmClipOrderUI) bgmClipOrderUI.value = task.bgmClipOrder || 'random';

    const globalBgmVol = _getGlobalBgmVolumePercent();
    const hasCustomBgmVol = task.bgmVolume != null;
    const bgmVol = hasCustomBgmVol ? task.bgmVolume : globalBgmVol;
    const bgmTaskVolRange = document.getElementById('reels-bgm-task-volume-range');
    const bgmTaskVolNum = document.getElementById('reels-bgm-task-volume-num');
    if (bgmTaskVolRange) {
        bgmTaskVolRange.value = bgmVol;
        bgmTaskVolRange.dataset.isCustom = hasCustomBgmVol ? 'true' : 'false';
    }
    if (bgmTaskVolNum) {
        bgmTaskVolNum.value = bgmVol;
        bgmTaskVolNum.dataset.isCustom = hasCustomBgmVol ? 'true' : 'false';
    }
};

window.reelsOnCvBlurBgChanged = function() {
    const isChecked = document.getElementById('reels-cv-blur-bg-ui').checked;
    if (isChecked) {
        const directEl = document.getElementById('reels-cv-direct-bg-ui');
        if (directEl) directEl.checked = false;
    }
    window.reelsSaveBgConfigUI();
};

window.reelsOnCvDirectBgChanged = function() {
    const isChecked = document.getElementById('reels-cv-direct-bg-ui').checked;
    if (isChecked) {
        const blurEl = document.getElementById('reels-cv-blur-bg-ui');
        if (blurEl) blurEl.checked = false;
    }
    window.reelsSaveBgConfigUI();
};

window.reelsSaveBgConfigUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    // 背景基本配置
    task.bgScale = parseInt(document.getElementById('reels-bg-scale-num').value) || 100;
    task.bgRotation = Math.max(-180, Math.min(180, parseFloat(document.getElementById('reels-bg-rotate-num').value) || 0));
    task.bgX = parseInt(document.getElementById('reels-bg-x-num').value) || 0;
    task.bgY = parseInt(document.getElementById('reels-bg-y-num').value) || 0;
    task.bgFlipH = document.getElementById('reels-bg-fliph-ui').checked;
    task.bgFlipV = document.getElementById('reels-bg-flipv-ui').checked;
    
    const bgVolRange = document.getElementById('reels-bg-volume-range');
    const bgVolNum = document.getElementById('reels-bg-volume-num');
    const bgVolVal = parseInt((bgVolNum || {}).value);

    // If the user is directly interacting with the right panel volume inputs, force isCustom to 'true'
    if (bgVolRange && bgVolNum && (document.activeElement === bgVolRange || document.activeElement === bgVolNum)) {
        bgVolRange.dataset.isCustom = 'true';
        bgVolNum.dataset.isCustom = 'true';
    }

    if (bgVolRange && bgVolRange.dataset.isCustom === 'true' && !isNaN(bgVolVal) && bgVolVal !== 100) {
        task.bgVideoVolume = bgVolVal;
    } else {
        delete task.bgVideoVolume;
    }

    // 配乐音量配置
    const bgmVolRange = document.getElementById('reels-bgm-task-volume-range');
    const bgmVolNum = document.getElementById('reels-bgm-task-volume-num');
    const bgmVolVal = parseInt((bgmVolNum || {}).value);

    if (bgmVolRange && bgmVolNum && (document.activeElement === bgmVolRange || document.activeElement === bgmVolNum)) {
        bgmVolRange.dataset.isCustom = 'true';
        bgmVolNum.dataset.isCustom = 'true';
    }

    if (bgmVolRange && bgmVolRange.dataset.isCustom === 'true' && !isNaN(bgmVolVal)) {
        task.bgmVolume = bgmVolVal;
    } else {
        delete task.bgmVolume;
    }

    const bgmClipOrderEl = document.getElementById('reels-bgm-cliporder-ui');
    if (bgmClipOrderEl) {
        task.bgmClipOrder = bgmClipOrderEl.value || 'random';
    }

    task.bgDurScale = parseInt(document.getElementById('reels-bg-dur-scale-num').value) || 100;

    // 背景多素材转场配置
    task.bgTransition = document.getElementById('reels-bg-transition-ui').value || 'crossfade';
    task.bgTransDur = parseFloat(document.getElementById('reels-bg-transdur-num').value) || 0.5;
    const clipOrderEl = document.getElementById('reels-bg-cliporder-ui');
    task.bgClipOrder = clipOrderEl ? (clipOrderEl.value || 'random') : (task.bgClipOrder || 'random');

    // 内容视频属性
    task.contentVideoBlurBg = document.getElementById('reels-cv-blur-bg-ui').checked;
    const directBgEl = document.getElementById('reels-cv-direct-bg-ui');
    task.contentVideoDirectBg = directBgEl ? directBgEl.checked : false;
    const blurParamsContainer = document.getElementById('reels-cv-blur-params-container');
    if (blurParamsContainer) {
        blurParamsContainer.style.display = task.contentVideoBlurBg ? 'flex' : 'none';
    }
    const blurNum = document.getElementById('reels-cv-blur-num');
    task.contentVideoBlur = blurNum ? (parseInt(blurNum.value) ?? 40) : 40;
    const brightNum = document.getElementById('reels-cv-brightness-num');
    task.contentVideoBrightness = brightNum ? (parseInt(brightNum.value) ?? 60) : 60;
    
    const cvVolVal = parseInt(document.getElementById('reels-cv-volume-num').value);
    task.contentVideoVolume = isNaN(cvVolVal) ? 100 : cvVolVal;

    task.contentVideoScale = parseInt(document.getElementById('reels-cv-scale-num').value) || 100;
    const cvPosScaleEl = document.getElementById('reels-cv-pos-scale-val');
    if (cvPosScaleEl) cvPosScaleEl.value = task.contentVideoScale;

    // 内容视频位置偏移 (X / Y px)
    const cvXNumEl = document.getElementById('reels-cv-x-num');
    const cvYNumEl = document.getElementById('reels-cv-y-num');
    if (cvXNumEl) {
        const vx = parseFloat(cvXNumEl.value) || 0;
        task.contentVideoX = vx === 0 ? 'center' : String(vx);
        const cvPosXValEl = document.getElementById('reels-cv-pos-x-val');
        if (cvPosXValEl) cvPosXValEl.value = task.contentVideoX;
    }
    if (cvYNumEl) {
        const vy = parseFloat(cvYNumEl.value) || 0;
        task.contentVideoY = vy === 0 ? 'center' : String(vy);
        const cvPosYValEl = document.getElementById('reels-cv-pos-y-val');
        if (cvPosYValEl) cvPosYValEl.value = task.contentVideoY;
    }

    task.contentVideoFlipH = document.getElementById('reels-cv-fliph-ui').checked;
    task.contentVideoFlipV = document.getElementById('reels-cv-flipv-ui').checked;
    
    const trimStartVal = document.getElementById('reels-cv-trim-start').value.trim();
    task.contentVideoTrimStart = trimStartVal === '' ? null : parseFloat(trimStartVal);
    
    const trimEndVal = document.getElementById('reels-cv-trim-end').value.trim();
    task.contentVideoTrimEnd = trimEndVal === '' ? null : parseFloat(trimEndVal);

    // 空间画面裁切
    const cLeft = parseFloat(document.getElementById('reels-cv-crop-left').value) || 0;
    const cTop = parseFloat(document.getElementById('reels-cv-crop-top').value) || 0;
    const cWidth = parseFloat(document.getElementById('reels-cv-crop-width').value) || 100;
    const cHeight = parseFloat(document.getElementById('reels-cv-crop-height').value) || 100;
    
    if (cLeft !== 0 || cTop !== 0 || cWidth !== 100 || cHeight !== 100) {
        task.contentVideoCrop = `${cLeft},${cTop},${cWidth},${cHeight}`;
    } else {
        task.contentVideoCrop = '';
    }

    // 若开启了【同步调节整个队列所有任务】，实时同步背景/内容视频/配乐参数到目标队列任务
    if (_isBgQueueSyncEnabled()) {
        const targets = _getBgQueueTargetTasks();
        for (const t of targets) {
            if (t && t !== task) {
                _copyBgParamsToTask(task, t);
                _copyCvParamsToTask(task, t);
                _copyBgmParamsToTask(task, t);
            }
        }
        _refreshBgQueueSyncBadge();
    }

    console.log('[BgConfigUI] Saved config: bgScale=' + task.bgScale + ' bgVideoVolume=' + task.bgVideoVolume + ' bgDurScale=' + task.bgDurScale + ' bgMode=' + task.bgMode + ' bgTransition=' + task.bgTransition + ' bgTransDur=' + task.bgTransDur + ' contentVideoBlurBg=' + task.contentVideoBlurBg + ' contentVideoVolume=' + task.contentVideoVolume + ' crop=' + task.contentVideoCrop + ' syncAll=' + _isBgQueueSyncEnabled());

    // 重新渲染批量表和预览
    if (typeof _applyPreviewAudioMix === 'function') _applyPreviewAudioMix();
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    _flushBgQueueTableAndHistory({ immediate: false });
};

window.reelsSetCvOffsetUI = function(axis, value) {
    const el = document.getElementById('reels-cv-' + axis + '-num');
    const elRange = document.getElementById('reels-cv-' + axis + '-range');
    if (el) el.value = value;
    if (elRange) elRange.value = value;
    window.reelsSaveBgConfigUI();
};

window.reelsApplyBgConfigToAllTasks = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0 || !_reelsState.tasks[idx]) return;
    window.reelsSaveBgConfigUI();
    const sourceTask = _reelsState.tasks[idx];
    const targets = _getBgQueueTargetTasks();
    for (const t of targets) {
        if (t && t !== sourceTask) {
            _copyBgParamsToTask(sourceTask, t);
        }
    }
    _flushBgQueueTableAndHistory({ immediate: true });
    if (typeof showToast === 'function') {
        showToast(`✅ 已将当前【背景参数】应用到队列 ${targets.length} 个任务`, 'success');
    }
};

window.reelsApplyCvConfigToAllTasks = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0 || !_reelsState.tasks[idx]) return;
    window.reelsSaveBgConfigUI();
    const sourceTask = _reelsState.tasks[idx];
    const targets = _getBgQueueTargetTasks();
    for (const t of targets) {
        if (t && t !== sourceTask) {
            _copyCvParamsToTask(sourceTask, t);
        }
    }
    _flushBgQueueTableAndHistory({ immediate: true });
    if (typeof showToast === 'function') {
        showToast(`✅ 已将当前【内容视频参数】应用到队列 ${targets.length} 个任务`, 'success');
    }
};

window.reelsApplyBgmConfigToAllTasks = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0 || !_reelsState.tasks[idx]) return;
    window.reelsSaveBgConfigUI();
    const sourceTask = _reelsState.tasks[idx];
    const targets = _getBgQueueTargetTasks();
    for (const t of targets) {
        if (t && t !== sourceTask) {
            _copyBgmParamsToTask(sourceTask, t);
        }
    }
    _flushBgQueueTableAndHistory({ immediate: true });
    if (typeof showToast === 'function') {
        showToast(`✅ 已将当前【配乐参数】应用到队列 ${targets.length} 个任务`, 'success');
    }
};

window.reelsApplyBgmMediaAndConfigToAllTasks = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0 || !_reelsState.tasks[idx]) return;
    window.reelsSaveBgConfigUI();
    const sourceTask = _reelsState.tasks[idx];
    const targets = _getBgQueueTargetTasks();
    for (const t of targets) {
        if (t && t !== sourceTask) {
            t.bgmMode = sourceTask.bgmMode || 'single';
            t.bgmPath = sourceTask.bgmPath || '';
            t.bgmClipPool = Array.isArray(sourceTask.bgmClipPool) ? [...sourceTask.bgmClipPool] : [];
            t.bgmClipActivePool = Array.isArray(sourceTask.bgmClipActivePool) ? [...sourceTask.bgmClipActivePool] : [];
            _copyBgmParamsToTask(sourceTask, t);
        }
    }
    _flushBgQueueTableAndHistory({ immediate: true });
    if (typeof showToast === 'function') {
        showToast(`🎵 已将当前配乐素材及参数同步到队列 ${targets.length} 个任务`, 'success');
    }
};

window.reelsApplyAllBgCvBgmToQueue = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0 || !_reelsState.tasks[idx]) return;
    window.reelsSaveBgConfigUI();
    const sourceTask = _reelsState.tasks[idx];
    const targets = _getBgQueueTargetTasks();
    for (const t of targets) {
        if (t && t !== sourceTask) {
            _copyBgParamsToTask(sourceTask, t);
            _copyCvParamsToTask(sourceTask, t);
            _copyBgmParamsToTask(sourceTask, t);
        }
    }
    _flushBgQueueTableAndHistory({ immediate: true });
    if (typeof showToast === 'function') {
        showToast(`✅ 已将当前【背景 + 内容视频 + 配乐】全部参数同步到队列 ${targets.length} 个任务`, 'success');
    }
};

window.reelsCopyBgToCvAllTasks = function() {
    const idx = _reelsState.selectedIdx;
    if (idx >= 0 && _reelsState.tasks[idx]) {
        window.reelsSaveBgConfigUI();
    }
    const sourceTask = idx >= 0 ? _reelsState.tasks[idx] : null;
    const targets = _getBgQueueTargetTasks();
    let updatedCount = 0;
    for (const t of targets) {
        if (!t) continue;
        const bgFile = t.bgPath || t.videoPath || '';
        if (bgFile) {
            t.contentVideoPath = bgFile;
            updatedCount++;
        }
        if (sourceTask && t !== sourceTask) {
            _copyCvParamsToTask(sourceTask, t);
        }
    }
    if (sourceTask) {
        const cvPathEl = document.getElementById('reels-cv-path-ui');
        if (cvPathEl) cvPathEl.value = sourceTask.contentVideoPath || '';
    }
    _flushBgQueueTableAndHistory({ immediate: true });
    if (idx >= 0 && typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof showToast === 'function') {
        showToast(`🔁 已将队列中 ${updatedCount} 个任务的背景设为内容视频，并同步内容视频参数`, 'success');
    }
};

window.reelsCopyCvToBgAllTasks = function() {
    const idx = _reelsState.selectedIdx;
    if (idx >= 0 && _reelsState.tasks[idx]) {
        window.reelsSaveBgConfigUI();
    }
    const sourceTask = idx >= 0 ? _reelsState.tasks[idx] : null;
    const targets = _getBgQueueTargetTasks();
    let updatedCount = 0;
    for (const t of targets) {
        if (!t) continue;
        if (t.contentVideoPath) {
            const oldPaths = [t.bgPath, t.videoPath, t.concatVideoPath].filter(Boolean);
            t.bgPath = t.contentVideoPath;
            t.videoPath = t.contentVideoPath;
            t.bgSrcUrl = null;
            t.srcUrl = null;
            if (typeof window.reelsPurgeTaskBackgroundMedia === 'function') {
                window.reelsPurgeTaskBackgroundMedia(t, { extraPaths: [...oldPaths, t.bgPath] });
            } else {
                t.timeline = null;
                t.renderPlan = null;
            }
            updatedCount++;
        }
        if (sourceTask && t !== sourceTask) {
            _copyBgParamsToTask(sourceTask, t);
        }
    }
    if (sourceTask) {
        const bgPathEl = document.getElementById('reels-bg-path-ui');
        if (bgPathEl) bgPathEl.value = sourceTask.bgPath || '';
    }
    _flushBgQueueTableAndHistory({ immediate: true });
    if (idx >= 0 && typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof showToast === 'function') {
        showToast(`🔁 已将队列中 ${updatedCount} 个任务的内容视频设为背景，并同步背景参数`, 'success');
    }
};

window.reelsClearCvPathAllTasks = function() {
    const targets = _getBgQueueTargetTasks();
    if (!targets.length) return;
    let clearedCount = 0;
    for (const t of targets) {
        if (t && t.contentVideoPath) {
            t.contentVideoPath = '';
            clearedCount++;
        }
    }
    const cvPathEl = document.getElementById('reels-cv-path-ui');
    const idx = _reelsState.selectedIdx;
    if (cvPathEl && idx >= 0 && _reelsState.tasks[idx]) {
        cvPathEl.value = _reelsState.tasks[idx].contentVideoPath || '';
    }
    _flushBgQueueTableAndHistory({ immediate: true });
    if (idx >= 0 && typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof showToast === 'function') {
        showToast(`🧹 已清除队列中 ${clearedCount} 个任务的内容视频`, 'info');
    }
};

window.reelsToggleBgModeUI = function(mode) {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    const oldPaths = [task.bgPath, task.videoPath, task.concatVideoPath].filter(Boolean);
    task.bgMode = mode;
    if (mode === 'single') {
        task.bgClipPool = [];
        task.bgClipActivePool = [];
        task.bgClipOrder = 'random';
    } else if (mode === 'multi') {
        task.bgPath = '';
        task.videoPath = '';
        task.bgSrcUrl = '';
        task.srcUrl = '';
        task.bgClipPool = Array.isArray(task.bgClipPool) ? task.bgClipPool : [];
        task.bgClipActivePool = Array.isArray(task.bgClipActivePool) ? task.bgClipActivePool : [];
        task.bgClipOrder = task.bgClipOrder || 'random';
        if (typeof window.reelsPurgeTaskBackgroundMedia === 'function') {
            window.reelsPurgeTaskBackgroundMedia(task, { extraPaths: oldPaths });
        }
    }
    
    // 面板显示切换
    const singleContainer = document.getElementById('reels-bg-single-container');
    const multiContainer = document.getElementById('reels-bg-multi-container');
    if (singleContainer) singleContainer.style.display = mode === 'single' ? 'flex' : 'none';
    if (multiContainer) multiContainer.style.display = mode === 'multi' ? 'flex' : 'none';

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsManageBgPoolUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    if (window.reelsShowBgPoolDialog) {
        window.reelsShowBgPoolDialog(idx);
    }
};

window.reelsSelectClipPoolUI = async function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    if (window.reelsPickClipPool) {
        await window.reelsPickClipPool(idx);
        const task = _reelsState.tasks[idx];
        window.reelsSyncBackgroundTabUI(task);
    }
};

window.reelsClearClipPoolUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;
    const oldPaths = [
        task.concatVideoPath,
        ...(Array.isArray(task.clipPool) ? task.clipPool.map(c => typeof c === 'string' ? c : c?.path) : []),
    ].filter(Boolean);
    task.clipPoolDir = '';
    task.clipPool = [];
    task.concatStatus = '';
    task.concatVideoPath = '';
    if (typeof window.reelsPurgeMediaCaches === 'function' && oldPaths.length > 0) {
        window.reelsPurgeMediaCaches(oldPaths);
    }
    
    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    window.reelsSyncBackgroundTabUI(task);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsChangeClipOrderUI = function(order) {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;
    task.clipOrder = order;
    
    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsConcatClipPoolUI = async function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    if (window.reelsConcatTaskClipPool) {
        const statusEl = document.getElementById('reels-bg-clippool-status-ui');
        if (statusEl) statusEl.textContent = '⏳ 拼接中...';
        const btn = document.getElementById('reels-bg-clippool-concat-btn');
        if (btn) btn.disabled = true;
        
        try {
            await window.reelsConcatTaskClipPool(idx);
        } finally {
            if (btn) btn.disabled = false;
            const task = _reelsState.tasks[idx];
            window.reelsSyncBackgroundTabUI(task);
        }
    }
};
window.reelsToggleBgmModeUI = function(mode) {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    task.bgmMode = mode;
    if (mode === 'single') {
        task.bgmClipPool = [];
        task.bgmClipActivePool = [];
        task.bgmClipOrder = 'random';
    }
    
    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    window.reelsSyncBackgroundTabUI(task);
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsSelectBgmPathUI = async function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    const path = await _pickSingleFile('选择配乐素材 (音频)', ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'wma']);
    if (path) {
        task.bgmPath = path;
        document.getElementById('reels-bgm-path-ui').value = path;
        
        if (typeof _renderBatchTable === 'function') {
            if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
            _renderBatchTable();
        }
        if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    }
};

window.reelsClearBgmPathUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    task.bgmPath = '';
    document.getElementById('reels-bgm-path-ui').value = '';

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsManageBgmPoolUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    if (window.reelsShowBgmPoolDialog) {
        window.reelsShowBgmPoolDialog(idx);
    }
};

window.reelsSelectBgPathUI = async function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    const path = await _pickSingleFile('选择背景素材 (图片/视频)', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif']);
    if (path) {
        const oldPaths = [task.bgPath, task.videoPath, task.concatVideoPath].filter(Boolean);
        task.bgPath = path;
        task.videoPath = path;
        task.bgSrcUrl = null;
        task.srcUrl = null;
        document.getElementById('reels-bg-path-ui').value = path;
        if (typeof window.reelsPurgeTaskBackgroundMedia === 'function') {
            window.reelsPurgeTaskBackgroundMedia(task, { extraPaths: [...oldPaths, path] });
        } else {
            task.timeline = null;
            task.renderPlan = null;
        }
        
        if (typeof _renderBatchTable === 'function') {
            if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
            _renderBatchTable();
        }
        if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    }
};

window.reelsClearBgPathUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    const oldPaths = [task.bgPath, task.videoPath, task.concatVideoPath].filter(Boolean);
    task.bgPath = '';
    task.videoPath = '';
    task.bgSrcUrl = '';
    task.srcUrl = '';
    document.getElementById('reels-bg-path-ui').value = '';
    if (typeof window.reelsPurgeTaskBackgroundMedia === 'function') {
        window.reelsPurgeTaskBackgroundMedia(task, { extraPaths: oldPaths });
    } else {
        task.timeline = null;
        task.renderPlan = null;
    }

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsSelectCvPathUI = async function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    const path = await _pickSingleFile('选择内容视频', ['mp4', 'mov', 'avi', 'mkv', 'webm']);
    if (path) {
        task.contentVideoPath = path;
        document.getElementById('reels-cv-path-ui').value = path;

        if (typeof _renderBatchTable === 'function') {
            if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
            _renderBatchTable();
        }
        if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    }
};

window.reelsClearCvPathUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    task.contentVideoPath = '';
    document.getElementById('reels-cv-path-ui').value = '';

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsResetCvCropUI = function() {
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        const elRange = document.getElementById(id + '-range');
        if (el) el.value = val;
        if (elRange) elRange.value = val;
    };
    setVal('reels-cv-crop-left', 0);
    setVal('reels-cv-crop-top', 0);
    setVal('reels-cv-crop-width', 100);
    setVal('reels-cv-crop-height', 100);
    window.reelsSaveBgConfigUI();
};

window.reelsApplyCropPresetUI = function(preset) {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    let left = 0, top = 0, width = 100, height = 100;

    if (preset === 'full') {
        left = 0; top = 0; width = 100; height = 100;
    } else if (preset === 'half_height') {
        left = 0; top = 25; width = 100; height = 50;
    } else {
        let targetRatio = 16/9;
        if (preset === '16_9') targetRatio = 16 / 9;
        else if (preset === '4_5') targetRatio = 4 / 5;
        else if (preset === '1_1') targetRatio = 1 / 1;
        else if (preset === '9_16') targetRatio = 9 / 16;
        else if (preset === '1_2') targetRatio = 1 / 2;

        let srcW = 1080, srcH = 1920;
        const cvVideo = document.getElementById('reels-preview-contentvideo');
        const img = window._reelsState.previewContentImage;
        const seq = window._reelsState.cvSequence;

        if (cvVideo && cvVideo.videoWidth > 0) {
            srcW = cvVideo.videoWidth;
            srcH = cvVideo.videoHeight;
        } else if (img && img.naturalWidth > 0) {
            srcW = img.naturalWidth;
            srcH = img.naturalHeight;
        } else if (seq && seq.files && seq.files.length > 0) {
            const firstFile = seq.files[0];
            const firstImg = seq.loadedImages?.[firstFile];
            if (firstImg && firstImg.naturalWidth > 0) {
                srcW = firstImg.naturalWidth;
                srcH = firstImg.naturalHeight;
            }
        } else {
            const renderer = window._reelsState.renderer;
            if (renderer && renderer.canvas) {
                srcW = renderer.canvas.width;
                srcH = renderer.canvas.height;
            }
        }

        const srcRatio = srcW / srcH;
        if (targetRatio > srcRatio) {
            const newH = srcW / targetRatio;
            const hPct = Math.round((newH / srcH) * 100);
            left = 0;
            width = 100;
            height = Math.max(1, Math.min(100, hPct));
            top = Math.round((100 - height) / 2);
        } else {
            const newW = srcH * targetRatio;
            const wPct = Math.round((newW / srcW) * 100);
            top = 0;
            height = 100;
            width = Math.max(1, Math.min(100, wPct));
            left = Math.round((100 - width) / 2);
        }
    }

    const setVal = (id, val) => {
        const el = document.getElementById(id);
        const elRange = document.getElementById(id + '-range');
        if (el) el.value = val;
        if (elRange) elRange.value = val;
    };

    setVal('reels-cv-crop-left', left);
    setVal('reels-cv-crop-top', top);
    setVal('reels-cv-crop-width', width);
    setVal('reels-cv-crop-height', height);

    window.reelsSaveBgConfigUI();
};

window.reelsCopyCvToBgUI = function() {
    if (_isBgQueueSyncEnabled()) {
        window.reelsCopyCvToBgAllTasks();
        return;
    }
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    if (!task.contentVideoPath) {
        alert('当前任务没有设置内容视频');
        return;
    }

    const oldPaths = [task.bgPath, task.videoPath, task.concatVideoPath].filter(Boolean);
    task.bgPath = task.contentVideoPath;
    task.videoPath = task.contentVideoPath;
    task.bgSrcUrl = null;
    task.srcUrl = null;
    document.getElementById('reels-bg-path-ui').value = task.bgPath;
    if (typeof window.reelsPurgeTaskBackgroundMedia === 'function') {
        window.reelsPurgeTaskBackgroundMedia(task, { extraPaths: [...oldPaths, task.bgPath] });
    } else {
        task.timeline = null;
        task.renderPlan = null;
    }

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsCopyBgToCvUI = function() {
    if (_isBgQueueSyncEnabled()) {
        window.reelsCopyBgToCvAllTasks();
        return;
    }
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    if (!task.bgPath) {
        alert('当前任务没有设置背景文件');
        return;
    }

    task.contentVideoPath = task.bgPath;
    document.getElementById('reels-cv-path-ui').value = task.contentVideoPath;

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsResetParamUI = function(idPrefix, defaultValue) {
    const el = document.getElementById(idPrefix + '-num');
    const elRange = document.getElementById(idPrefix + '-range');
    if (el) {
        el.value = defaultValue;
        if (idPrefix === 'reels-bg-volume' || idPrefix === 'reels-bgm-task-volume') el.dataset.isCustom = 'false';
    }
    if (elRange) {
        elRange.value = defaultValue;
        if (idPrefix === 'reels-bg-volume' || idPrefix === 'reels-bgm-task-volume') elRange.dataset.isCustom = 'false';
    }
    window.reelsSaveBgConfigUI();
};

window.reelsResetTrimUI = function(id) {
    const el = document.getElementById(id);
    if (el) el.value = '';
    window.reelsSaveBgConfigUI();
};

window.reelsSetBgOffsetUI = function(axis, value) {
    const el = document.getElementById('reels-bg-' + axis + '-num');
    const elRange = document.getElementById('reels-bg-' + axis + '-range');
    if (el) el.value = value;
    if (elRange) elRange.value = value;
    window.reelsSaveBgConfigUI();
};

window.reelsSetSpeechWritingTip = function(kind) {
    const set = (id, value, check = false) => { const el=document.getElementById(id); if(el) {if(check)el.checked=value;else el.value=value;} };
    set('reels-fullpage-typewriter', true, true);
    set('reels-fullpage-typewriter-cursor', true, true);
    set('reels-fullpage-typewriter-speech-sync', true, true);
    set('reels-fullpage-typewriter-reveal-type', 'char');
    set('reels-fullpage-typewriter-cursor-kind', kind);
    set('reels-fullpage-typewriter-cursor-scale', kind === 'rose' ? .75 : 1.4);
    set('reels-fullpage-typewriter-cursor-offset-x', 0);
    set('reels-fullpage-typewriter-cursor-offset-y', 0);
    set('reels-fullpage-typewriter-cursor-angle', 0);
    set('reels-scrolling-mode', false, true);
    set('reels-tw-unrevealed-opacity', 0);
    set('reels-tw-unrevealed-opacity-range', 0);
    const options=document.getElementById('reels-fullpage-typewriter-options');if(options)options.style.display='';
    const control=document.getElementById('reels-fullpage-typewriter-cursor-kind');
    if(control)control.dispatchEvent(new Event('change', {bubbles:true}));
    reelsRefreshSpeechWritingPreview();
};
window.reelsRefreshSpeechWritingPreview = function() {
    if(typeof reelsUpdatePreview==='function')reelsUpdatePreview();
    if(window.ReelsPreviewV2?.isOpen?.())window.ReelsPreviewV2.render();
};

window.reelsRefreshWritingTitleEditor = function() {
    const auto=document.getElementById('reels-fullpage-typewriter-title-auto');
    const input=document.getElementById('reels-fullpage-typewriter-title-text');
    const task=typeof _getSelectedTask==='function'?_getSelectedTask():null;
    if(auto?.checked && input) {
        const parts=getSplitWritingParts(task?.segments||[],{fullpage_typewriter_title_auto:true},task?.ttsText||task?.aiScript||'');
        input.value=parts.title[0]?.text||'';
    }
    const options=document.getElementById('reels-writing-split-options');
    if(options)options.style.display=document.getElementById('reels-fullpage-typewriter-split')?.checked?'':'none';
};
window.reelsWritingTitleTextChanged = function() {
    const auto=document.getElementById('reels-fullpage-typewriter-title-auto');if(auto)auto.checked=false;
    const task=typeof _getSelectedTask==='function'?_getSelectedTask():null;if(task)task.writingTitle=document.getElementById('reels-fullpage-typewriter-title-text')?.value||'';
    if(typeof _persistSubtitleStyleByScope==='function')_persistSubtitleStyleByScope(_readStyleFromUI());
    if(typeof _batchAutoSave==='function')_batchAutoSave();
    reelsRefreshSpeechWritingPreview();
};
window.reelsWritingTitleFontFocus = function() {
    const source=document.getElementById('reels-font-family'),select=document.getElementById('reels-fullpage-typewriter-title-font');
    if(!source||!select)return;
    const value=select.value;select.replaceChildren();
    const follow=document.createElement('option');follow.value='';follow.textContent='跟随正文字体';select.appendChild(follow);
    for(const opt of source.options){if(!opt.value)continue;select.appendChild(opt.cloneNode(true));}
    if(value && !Array.from(select.options).some(opt=>opt.value===value)){const opt=document.createElement('option');opt.value=value;opt.textContent=value;select.appendChild(opt);}
    select.value=value;
};
window.reelsWritingTitleFontChanged = async function(fromUser=false) {
    reelsWritingTitleFontFocus();
    const select=document.getElementById('reels-fullpage-typewriter-title-font'),font=select?.value;
    if(fromUser){const follow=document.getElementById('reels-fullpage-typewriter-title-font-follow');if(follow)follow.checked=!font;_persistSubtitleStyleByScope(_readStyleFromUI());if(typeof _batchAutoSave==='function')_batchAutoSave();}
    if(font&&typeof getFontManager==='function'){try{await getFontManager().loadGoogleFont(font);}catch(error){console.warn('[WritingTitle] font load failed',error);}}
    reelsRefreshSpeechWritingPreview();
};
window.reelsEnableSplitWriting = function() {
    for(const id of ['reels-fullpage-typewriter','reels-fullpage-typewriter-split']){const el=document.getElementById(id);if(el)el.checked=true;}
    const options=document.getElementById('reels-fullpage-typewriter-options');if(options)options.style.display='';
    const auto=document.getElementById('reels-fullpage-typewriter-auto-sequence');if(auto)auto.checked=true;
    const reveal=document.getElementById('reels-fullpage-typewriter-title-reveal');if(reveal)reveal.value='char';
    for(const key of ['title-delay','body-delay']){const field=document.getElementById('reels-fullpage-typewriter-'+key);if(field)field.value=0;}
    reelsRefreshWritingTitleEditor();
    const el=document.getElementById('reels-fullpage-typewriter-split');if(el)el.dispatchEvent(new Event('change',{bubbles:true}));
    reelsRefreshSpeechWritingPreview();
};

window.reelsRefreshWritingFontSample=function(){
    const sample=document.getElementById('reels-writing-title-font-sample');
    const label=document.getElementById('reels-writing-title-font-label');
    if(!sample)return;
    const get=id=>document.getElementById('reels-fullpage-typewriter-'+id);
    const follow=get('title-font-follow')?.checked!==false;
    const font=(follow?document.getElementById('reels-font-family')?.value:get('title-font')?.value)||document.getElementById('reels-font-family')?.value||'Arial';
    sample.textContent=get('title-text')?.value?.trim()||'Aa Bb Cc · 字体效果预览';
    sample.style.fontFamily=JSON.stringify(font)+', serif';
    sample.style.fontWeight=get('title-weight')?.value||'700';
    sample.style.fontSize='28px';
    sample.style.color=get('title-color')?.value||'#ffd700';
    if(label)label.textContent=(follow?'跟随正文：':'标题字体：')+font;
};
window.reelsStepWritingTitleFont=function(direction){
    reelsWritingTitleFontFocus();
    const select=document.getElementById('reels-fullpage-typewriter-title-font');if(!select?.options?.length)return;
    select.selectedIndex=(Math.max(0,select.selectedIndex)+direction+select.options.length)%select.options.length;
    select.dispatchEvent(new Event('change',{bubbles:true}));
};
const _refreshSpeechWritingWithFontSample=window.reelsRefreshSpeechWritingPreview;
window.reelsRefreshSpeechWritingPreview=function(...args){
    reelsRefreshWritingFontSample();
    return _refreshSpeechWritingWithFontSample?.apply(this,args);
};

window.reelsUploadSpeechWritingImage=async function(){
    try{
        const files=await window.electronAPI.selectFiles({title:'上传跟随出字的图片',multiple:false,filters:[{name:'图片',extensions:['png','jpg','jpeg','webp','gif']}]});
        if(!files?.[0])return;
        const result=window.electronAPI.importWritingCursorImage(files[0]);
        if(!result?.ok)throw new Error(result?.error||'图片上传失败');
        const probe=new Image();await new Promise((resolve,reject)=>{probe.onload=resolve;probe.onerror=()=>reject(new Error('图片无法读取，请选择 PNG、JPG、WebP 或 GIF 图片。'));probe.src=window.electronAPI.toFileUrl(result.path);});
        if(/\.gif$/i.test(result.path)) {
            const check=new ReelsCanvasRenderer(document.createElement('canvas'));
            await check.prepareWritingCursorImage({fullpage_typewriter_cursor_kind:'image',fullpage_typewriter_cursor_image:result.path});
        }
        document.getElementById('reels-fullpage-typewriter-cursor-image').value=result.path;
        reelsSetSpeechWritingTip('image');
        if(typeof _persistSubtitleStyleByScope==='function')_persistSubtitleStyleByScope(_readStyleFromUI());
        if(typeof _batchAutoSave==='function')_batchAutoSave();
        reelsRefreshSpeechWritingPreview();
    }catch(error){alert('上传出字图片失败：'+(error.message||String(error)));}
};
window.reelsRefreshSpeechWritingImageUI=function(){
    const path=document.getElementById('reels-fullpage-typewriter-cursor-image')?.value||'';
    const row=document.getElementById('reels-writing-custom-image-options');
    if(row)row.style.display=document.getElementById('reels-fullpage-typewriter-cursor-kind')?.value==='image'?'':'none';
    const thumb=document.getElementById('reels-writing-custom-image-preview');
    if(thumb){const url=path?(window.electronAPI?.toFileUrl?.(path)||path):'';if(thumb.getAttribute('src')!==url){if(url)thumb.src=url;else thumb.removeAttribute('src');}thumb.style.display=path?'':'none';}
    const label=document.getElementById('reels-writing-custom-image-name');if(label)label.textContent=path?'已上传图片，可使用大小、偏移、角度调整':'尚未上传图片';
};
const _refreshWritingBeforeCustomImage=window.reelsRefreshSpeechWritingPreview;
window.reelsRefreshSpeechWritingPreview=function(...args){
    reelsRefreshSpeechWritingImageUI();
    return _refreshWritingBeforeCustomImage?.apply(this,args);
};

