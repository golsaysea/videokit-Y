/**
 * reels-render-plan.js — Reels 时间线与渲染器之间的唯一适配层。
 *
 * 编辑器不直接拥有一份“仅供显示”的轨道数据。task.timeline 是编辑事实，
 * 本模块将其同步为现有预览/导出器需要的兼容字段。这样两条渲染路径在开始
 * 前读取的是同一份任务状态，旧项目也仍可打开。
 */
(function (root) {
    const TimelineLib = typeof require === 'function' && typeof window === 'undefined'
        ? require('./reels-timeline.js')
        : root.ReelsTimeline;

    function finite(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function sourceFor(timeline, path, duration = 0, kind = '') {
        if (!path) return '';
        const found = Object.values(timeline.sources).find((source) => source.path === path);
        if (found) {
            found.duration = Math.max(finite(found.duration), finite(duration));
            return found.id;
        }
        const source = new TimelineLib.MediaSource(path);
        source.duration = Math.max(0, finite(duration));
        source.hasVideo = !['voice', 'bgm', 'sfx'].includes(kind);
        source.hasAudio = kind !== 'overlay';
        timeline.sources[source.id] = source;
        return source.id;
    }

    function trackFor(timeline, type, label, trackRole = '') {
        // 同为 audio/video 的素材不能自动合到一条轨道：背景原声、人声 MP3、
        // 配乐必须各自可见、可静音和可编辑。trackRole 是显示轨道的稳定身份。
        let track = trackRole
            ? timeline.tracks.find((item) => item.type === type && item._extra?.trackRole === trackRole)
            : timeline.findTrackByType(type);
        if (!track) {
            track = new TimelineLib.Track(type);
            timeline.addTrack(track);
        }
        track._extra.label = label || track._extra.label || type;
        if (trackRole) track._extra.trackRole = trackRole;
        return track;
    }

    function addLegacyClip(timeline, type, role, path, duration, options = {}) {
        if (!path) return null;
        const track = trackFor(timeline, type, options.label, options.trackRole || role);
        const sourceId = sourceFor(timeline, path, duration, role);
        const clip = new TimelineLib.Clip(sourceId, finite(options.inT), Math.max(finite(options.outT, duration), 0), finite(options.startT));
        clip.followRipple = options.followRipple !== false;
        clip.linkGroupId = options.linkGroupId || '';
        clip._extra.role = role;
        track.clips.push(clip);
        return clip;
    }

    function taskDuration(task, options = {}) {
        const lastSubtitleEnd = Array.isArray(task?.segments) && task.segments.length
            ? Math.max(...task.segments.map(segment => finite(segment.end)))
            : 0;
        return Math.max(
            finite(options.duration), finite(task?.customDuration), finite(task?.duration), lastSubtitleEnd, 1
        );
    }

    // 老项目可能已经保存了一份空的/早期的 timeline。不能因为它“存在”就
    // 停止同步；要补齐当前任务真实拥有的视频、原声、人声和配乐轨道。
    function ensureLegacyTracks(timeline, task, options = {}) {
        const duration = taskDuration(task, options);
        const backgroundSegments = Array.isArray(options.backgroundSegments) ? options.backgroundSegments.filter(segment => segment?.path) : [];
        const paths = {
            background: task.bgPath || task.videoPath || (Array.isArray(task.bgClipPool) ? task.bgClipPool.find(Boolean) : '') || (task.contentVideoDirectBg ? task.contentVideoPath : ''),
            voice: task.audioPath || task.voicePath || task.voice_path || task.audio_path || task.audio?.path || (typeof task.audio === 'string' ? task.audio : '') || '',
            bgm: task.bgmPath || task.bgm_path || (typeof task.bgm === 'string' ? task.bgm : (task.bgm?.path || '')) || '',
            content_video: task.contentVideoPath || task.content_video_path || '',
        };
        const removeRoleClips = (role) => {
            timeline.tracks.forEach((track) => {
                if (Array.isArray(track.clips)) {
                    track.clips = track.clips.filter(clip => clip?._extra?.role !== role);
                }
            });
        };
        const ensureRole = (type, role, path, config = {}) => {
            if (!path) {
                removeRoleClips(role);
                return null;
            }
            const existing = clipsByRole(timeline, role);
            if (existing.length) {
                const allMatch = existing.every(clip => (timeline.sources[clip.sourceId]?.path || '') === path);
                if (allMatch) return existing[0] || null;
                removeRoleClips(role);
                if (role === 'background') {
                    removeRoleClips('source_audio');
                    timeline._extra.backgroundSegmentKey = '';
                    if (task) delete task.timelineBackgroundTrim;
                }
            }
            const track = trackFor(timeline, type, config.label, config.trackRole || role);
            const candidate = track.clips.find(clip => timeline.sources[clip.sourceId]?.path === path);
            if (candidate) {
                candidate._extra = candidate._extra || {};
                candidate._extra.role = role;
                if (candidate.outT <= candidate.inT) candidate.outT = candidate.inT + duration;
                candidate.followRipple = config.followRipple !== false;
                return candidate;
            }
            return addLegacyClip(timeline, type, role, path, duration, config);
        };
        let background = null;
        if (backgroundSegments.length) {
            const videoTrack = trackFor(timeline, 'video', '背景视频（循环）', 'background');
            const audioTrack = trackFor(timeline, 'audio', '原声（绑定背景）', 'source_audio');
            // 已保存项目中可能仍是旧标签“背景拼接”；这里统一成用户能看懂的名称。
            videoTrack._extra.label = '背景视频（循环）';
            // 多背景不是一条“循环覆盖”大块。这里按与预览完全相同的分段结果
            // 生成独立 clips，让用户看见素材切换、裁剪长度和整片结束位置。
            const segmentKey = backgroundSegments.map((segment) => [
                segment.path, finite(segment.start), finite(segment.end), finite(segment.trimStart), finite(segment.duration), finite(segment.speedFactor, 1), segment.loopIndex ?? '',
            ].join('|')).join(';');
            // 切换任务、读取到真实媒体时长时才重建初始循环；用户拖过以后不能
            // 又被下一次 UI 刷新覆盖回去，否则就会产生截图中的重叠/空洞。
            const needsHydration = timeline._extra.backgroundSegmentKey !== segmentKey;
            if (needsHydration) {
                videoTrack.clips = videoTrack.clips.filter(clip => clip?._extra?.role !== 'background');
                audioTrack.clips = audioTrack.clips.filter(clip => clip?._extra?.role !== 'source_audio');
            }
            if (needsHydration) backgroundSegments.forEach((segment, index) => {
                const sourceId = sourceFor(timeline, segment.path, finite(segment.duration), 'background');
                const sourceIn = finite(segment.trimStart);
                const sourceOut = sourceIn + Math.max(.05, finite(segment.duration, 5)) * Math.max(.01, finite(segment.speedFactor, 1));
                const group = `bg_link_${index}_${Math.round(finite(segment.start) * 1000)}`;
                const video = new TimelineLib.Clip(sourceId, sourceIn, sourceOut, finite(segment.start));
                video.speed = Math.max(.01, finite(segment.speedFactor, 1));
                video.linkGroupId = group;
                video._extra.role = 'background';
                video._extra.sequenceIndex = index;
                video._extra.loopIndex = segment.loopIndex ?? null;
                video._extra.transition = task.bgTransition || 'none';
                videoTrack.clips.push(video);
                const originalAudio = new TimelineLib.Clip(sourceId, sourceIn, sourceOut, finite(segment.start));
                originalAudio.speed = video.speed;
                originalAudio.linkGroupId = group;
                originalAudio.isMain = true;
                originalAudio._extra.role = 'source_audio';
                originalAudio._extra.sequenceIndex = index;
                originalAudio._extra.loopIndex = index;
                audioTrack.clips.push(originalAudio);
            });
            timeline._extra.backgroundSegmentKey = segmentKey;
            background = videoTrack.clips[0] || null;
        } else {
            if (!paths.background) {
                removeRoleClips('background');
                removeRoleClips('source_audio');
                timeline._extra.backgroundSegmentKey = '';
                if (task) delete task.timelineBackgroundTrim;
            }
            background = ensureRole('video', 'background', paths.background, { label: '主视频' });
        }
        if (background && !backgroundSegments.length && !clipsByRole(timeline, 'source_audio').length) {
            const group = background.linkGroupId || (background.linkGroupId = `link_${background.id}`);
            ensureRole('audio', 'source_audio', paths.background, { label: '原声（绑定背景）', linkGroupId: group });
            const originalAudio = clipsByRole(timeline, 'source_audio')[0];
            if (originalAudio) originalAudio.linkGroupId = group;
        }
        ensureRole('audio', 'voice', paths.voice, { label: '人声 MP3' });
        ensureRole('bgm', 'bgm', paths.bgm, { label: '配乐', followRipple: false, startT: finite(task.bgmStart) });
        if (paths.content_video && paths.content_video !== paths.background) {
            ensureRole('video', 'content_video', paths.content_video, {
                label: '内容视频', inT: finite(task.contentVideoTrimStart), outT: finite(task.contentVideoTrimEnd, duration),
            });
        } else {
            removeRoleClips('content_video');
        }
        // 插入素材永远属于当前任务，不与背景素材池共用。时间线只是它的可视
        // 编辑投影；sourceTrim/timelineStart 等编辑后会同步回 task.insertClips。
        const insertClips = Array.isArray(task.insertClips) ? task.insertClips : [];
        const insertTrack = trackFor(timeline, 'video', '插入素材', 'insert_video');
        const insertKey = JSON.stringify(insertClips.map(item => [item.id, item.sourcePath, item.timelineStart, item.duration, item.sourceTrimStart, item.sourceTrimEnd]));
        if (timeline._extra.insertClipKey !== insertKey) {
            insertTrack.clips = insertTrack.clips.filter(clip => clip?._extra?.role !== 'insert_video');
            insertClips.filter(item => item && item.sourcePath).forEach((item, index) => {
                const start = Math.max(0, finite(item.timelineStart));
                const sourceIn = Math.max(0, finite(item.sourceTrimStart));
                const requestedDuration = Math.max(.05, finite(item.duration, 1.5));
                const sourceOut = Math.max(sourceIn + .05, finite(item.sourceTrimEnd, sourceIn + requestedDuration));
                const sourceDuration = Math.max(sourceOut, finite(item.sourceDuration, sourceOut));
                const sourceId = sourceFor(timeline, item.sourcePath, sourceDuration, 'insert_video');
                const clip = new TimelineLib.Clip(sourceId, sourceIn, sourceOut, start);
                clip._extra.role = 'insert_video';
                clip._extra.insertId = item.id || `insert_${index + 1}`;
                clip._extra.insertIndex = index;
                clip.fitMode = item.transform?.fit || 'fill';
                clip.x = finite(item.transform?.x);
                clip.y = finite(item.transform?.y);
                clip.scale = finite(item.transform?.scale, 100) / 100;
                clip.rotation = finite(item.transform?.rotation);
                clip.flipX = !!item.transform?.flipH;
                clip.flipY = !!item.transform?.flipV;
                insertTrack.clips.push(clip);
            });
            timeline._extra.insertClipKey = insertKey;
        }
        // 1. 规范化片段角色，识别未打标的遗留片段
        timeline.tracks.forEach((track) => {
            (track.clips || []).forEach((clip) => {
                if (!clip) return;
                clip._extra = clip._extra || {};
                if (!clip._extra.role) {
                    const srcPath = timeline.sources[clip.sourceId]?.path || '';
                    if (paths.voice && srcPath === paths.voice) clip._extra.role = 'voice';
                    else if (paths.bgm && srcPath === paths.bgm) clip._extra.role = 'bgm';
                    else if (paths.content_video && srcPath === paths.content_video) clip._extra.role = 'content_video';
                    else if (paths.background && srcPath === paths.background) {
                        clip._extra.role = track.domain === 'audio' ? 'source_audio' : 'background';
                    }
                }
                // 旧工程曾保存过 outT=0 的视频轨。它在恢复后会被当作“有
                // 片段但时长为零”，时间线因此显示整段红色缺口。只修复可识别
                // 的主/背景/内容视频，避免影响用户手工裁切的正常片段。
                if (['background', 'content_video'].includes(clip._extra.role) && clip.outT <= clip.inT) {
                    clip.outT = clip.inT + duration;
                    clip.startT = Math.max(0, finite(clip.startT));
                }
            });
        });

        // 兼容早期项目：将 source_audio 与 voice 归入独立轨道
        ['source_audio', 'voice'].forEach((role) => {
            const label = role === 'voice' ? '人声 MP3' : '原声（绑定背景）';
            const target = trackFor(timeline, 'audio', label, role);
            timeline.tracks.forEach((track) => {
                if (track === target) return;
                const moving = (track.clips || []).filter((clip) => clip?._extra?.role === role);
                if (!moving.length) return;
                track.clips = track.clips.filter((clip) => clip?._extra?.role !== role);
                target.clips.push(...moving);
            });
        });
        trackFor(timeline, 'subs', '字幕', 'subs');

        // 清理无效片段、空轨道与重复角色轨，保留所有有效有内容的轨道
        const seenTrackRoles = new Set();
        const SINGLETON_ROLES = new Set(['background', 'source_audio', 'voice', 'bgm', 'content_video', 'insert_video', 'subs']);
        let hasSubsTrack = false;
        timeline.tracks = timeline.tracks.filter((track) => {
            if (track.type === 'subs') {
                if (hasSubsTrack) return false;
                hasSubsTrack = true;
                track._extra.label = '字幕';
                return true;
            }
            if (Array.isArray(track.clips)) {
                track.clips = track.clips.filter((clip) => clip && clip.sourceId && timeline.sources[clip.sourceId]);
            }
            if (!Array.isArray(track.clips) || track.clips.length === 0) return false;
            const role = track._extra?.trackRole || '';
            if (role && SINGLETON_ROLES.has(role)) {
                if (seenTrackRoles.has(role)) return false;
                seenTrackRoles.add(role);
            }
            return true;
        });

        // 对背景视频与绑定原声进行防重叠校验，若发生重叠自动向后推移，彻底杜绝画面重叠
        const bgClips = clipsByRole(timeline, 'background').sort((a, b) => a.startT - b.startT);
        let prevEnd = 0;
        for (let i = 0; i < bgClips.length; i++) {
            const clip = bgClips[i];
            const linked = timeline.linkedClips(clip);
            const dur = Math.max(0.05, clip.effectiveDuration);
            if (clip.startT < prevEnd - 0.001) {
                linked.forEach((item) => {
                    item.startT = prevEnd;
                });
            }
            prevEnd = clip.startT + dur;
            linked.forEach((item) => {
                item._extra = item._extra || {};
                item._extra.sequenceIndex = i;
                item._extra.loopIndex = i;
            });
        }

        return timeline;
    }

    function ensureTimeline(task, options = {}) {
        if (!task || !TimelineLib) return null;
        if (task.timeline && typeof task.timeline.findTrackByType === 'function') {
            return ensureLegacyTracks(task.timeline, task, options);
        }
        if (task.timeline && typeof task.timeline === 'object') {
            task.timeline = TimelineLib.Timeline.fromJSON(task.timeline);
            return ensureLegacyTracks(task.timeline, task, options);
        }
        const tl = new TimelineLib.Timeline(options.width || 1080, options.height || 1920, 30);
        task.timeline = tl;
        return ensureLegacyTracks(tl, task, options);
    }

    function clipsByRole(timeline, role) {
        return timeline.tracks.flatMap((track) => track.clips || [])
            .filter((clip) => clip && clip._extra && clip._extra.role === role);
    }

    // 将时间线中“当前已被渲染器支持”的轨道投影到旧字段。
    // 多片段编排暂存为 renderPlan，不能悄悄降级成单片段导出。
    function syncLegacyFields(task, options = {}) {
        const timeline = ensureTimeline(task, options);
        if (!timeline) return task;
        const read = (role) => clipsByRole(timeline, role).sort((a, b) => a.startT - b.startT);
        const firstPath = (role) => {
            const clip = read(role)[0];
            return clip ? timeline.sources[clip.sourceId]?.path || '' : '';
        };
        const background = read('background');
        const voice = read('voice');
        const bgm = read('bgm');
        const content = read('content_video');
        if (background.length === 1) {
            const clip = background[0];
            const path = timeline.sources[clip.sourceId]?.path || '';
            task.bgPath = path || task.bgPath;
            task.videoPath = path || task.videoPath;
            task.timelineBackgroundTrim = { in_t: clip.inT, out_t: clip.outT, start_t: clip.startT };
        }
        if (voice.length === 1) task.audioPath = timeline.sources[voice[0].sourceId]?.path || task.audioPath;
        if (bgm.length === 1) {
            const clip = bgm[0];
            task.bgmPath = timeline.sources[clip.sourceId]?.path || task.bgmPath;
            task.bgmStart = clip.startT;
        }
        if (content.length === 1) {
            const clip = content[0];
            task.contentVideoPath = timeline.sources[clip.sourceId]?.path || task.contentVideoPath;
            task.contentVideoTrimStart = clip.inT;
            task.contentVideoTrimEnd = clip.outT;
        }
        task.renderPlan = {
            version: 1,
            timeline: timeline.toJSON(),
            unsupportedMultiClipRoles: ['background', 'voice', 'bgm', 'content_video'].filter((role) => read(role).length > 1),
        };
        return task;
    }

    function getEditorTracks(task, options = {}) {
        const timeline = ensureTimeline(task, options);
        if (!timeline) return [];
        // 只保留真正有片段的轨道以及单个标准字幕轨
        let hasSubsTrack = false;
        const eligibleTracks = timeline.tracks.filter((track) => {
            if (track.type === 'subs') {
                if (hasSubsTrack) return false;
                hasSubsTrack = true;
                return true;
            }
            // 旧工程可能遗留 source 为空或时长 0 的 video Clip；不能仅因为
            // clips.length>0 就显示成一条“缺整段画面”的空轨。
            return Array.isArray(track.clips) && track.clips.some((clip) => {
                const sourcePath = timeline.sources[clip?.sourceId]?.path || '';
                return !!sourcePath && finite(clip.effectiveDuration) > .05;
            });
        });
        // Timeline 模型的 visual 轨道从低到高保存；编辑器按常见 NLE 习惯
        // 从上到下显示高到低，因此需反向投影，避免“背景在上、插入在下”的
        // 视觉误导。音频轨保持原顺序。
        const tracks = [
            ...eligibleTracks.filter(track => track.domain === 'visual').reverse(),
            ...eligibleTracks.filter(track => track.domain !== 'visual'),
        ].map((track) => {
            const role = track._extra?.role || (track._extra?.label === '插入素材' ? 'insert_video' : '');
            let visible = track.visible !== false;
            if (role === 'insert_video') {
                if (task.insertClipsDisabled) visible = false;
            } else if (role === 'background' || (track.type === 'video' && !role)) {
                if (task.bgDisabled) visible = false;
            } else if (track.type === 'subs') {
                if (task.showSubtitle === false) visible = false;
            }
            return {
                type: track.type,
                name: track._extra.label || track.type,
                role,
                _timelineTrackId: track.id,
                locked: track.locked,
                visible,
                domain: track.domain,
                clips: track.clips.filter((clip) => {
                    const sourcePath = timeline.sources[clip?.sourceId]?.path || '';
                    return !!sourcePath && finite(clip.effectiveDuration) > .05;
                }).map((clip) => ({
                    start: clip.startT,
                    end: clip.startT + clip.effectiveDuration,
                    name: `${timeline.sources[clip.sourceId]?.path?.split(/[\\/]/).pop() || track._extra.label || track.type}${clip._extra?.loopIndex != null ? ` #${clip._extra.loopIndex + 1}` : ''}${role === 'insert_video' ? ` · 显示${clip.effectiveDuration.toFixed(1)}s/原始${(timeline.sources[clip.sourceId]?.duration || clip.outT).toFixed(1)}s` : ''}`,
                    color: undefined,
                    _timelineClipId: clip.id,
                    _timelineRole: clip._extra.role || '',
                    _insertId: clip._extra?.insertId || '',
                    _linkGroupId: clip.linkGroupId || '',
                    inT: clip.inT,
                    outT: clip.outT,
                    sourceDuration: timeline.sources[clip.sourceId]?.duration || clip.outT,
                    _loopIndex: clip._extra?.loopIndex,
                    _isLoopInstance: clip._extra?.loopIndex != null,
                })),
            };
        });
        const subtitles = Array.isArray(task.segments) ? task.segments : [];
        const subtitleTrack = tracks.find((track) => track.type === 'subs');
        if (subtitleTrack) {
            subtitleTrack.clips = subtitles.map((segment, index) => {
                const text = segment.edited_text || segment.text || segment.content || '';
                return {
                    start: finite(segment.start), end: finite(segment.end),
                    name: text.slice(0, 20) + (text.length > 20 ? '…' : ''),
                    _fullText: text, _segIdx: index,
                    styled_ranges: segment.styled_ranges || null,
                    style_override: segment.style_override || null,
                };
            });
        }

        // ── 覆层卡片轨（文字卡片、滚动字幕、图片覆层等）：每个覆层独立一条轨道 ──
        // 覆层渲染顺序从底到顶 (index 0 是底层，index N 是顶层)；
        // 时间线视觉轨道从上到下显示 (最上方轨道是顶层)，因此反向投影 overlays。
        const isCurrentTask = typeof window !== 'undefined'
            && window._reelsState?.tasks
            && window._reelsState.tasks[window._reelsState.selectedIdx] === task;
        const activeOverlays = (isCurrentTask && window._reelsState?.overlayProxy?.overlayMgr?.overlays) || task.overlays || [];
        const nonInsertOverlays = activeOverlays.filter(ov => !ov._insertClip);
        const totalDuration = options.duration || (taskDuration(task, options) || 10);
        if (nonInsertOverlays.length > 0) {
            const overlayTracks = nonInsertOverlays.slice().reverse().map((ov, revIdx) => {
                const index = nonInsertOverlays.length - 1 - revIdx;
                const start = Math.max(0, finite(ov.start, 0));
                let end = finite(ov.end, 5);
                if (end >= 9999) end = totalDuration;
                let label = ov.name;
                if (!label) {
                    if (ov.type === 'textcard') {
                        const txt = ov.title_text || ov.body_text || '';
                        label = txt ? `卡片: ${txt.slice(0, 10)}` : '文字卡片';
                    } else if (ov.type === 'scroll') {
                        label = `滚动: ${(ov.content || '').split('\n')[0].slice(0, 10) || '字幕'}`;
                    } else if (ov.type === 'text') {
                        label = `文本: ${(ov.content || '').slice(0, 10)}`;
                    } else if (ov.type === 'solid_mask') {
                        label = '纯色蒙版';
                    } else if (ov.type === 'video') {
                        label = '覆层视频';
                    } else {
                        label = '图片覆层';
                    }
                }
                const trackName = `${label} (#${index + 1})`;
                return {
                    type: 'overlay',
                    name: trackName,
                    _timelineTrackId: `track_overlay_${ov.id || index}`,
                    _overlayId: ov.id,
                    _overlayIndex: index,
                    locked: false,
                    visible: !ov.disabled,
                    domain: 'visual',
                    clips: (Array.isArray(ov.display_ranges) && ov.display_ranges.length
                        ? ov.display_ranges
                        : [{ start, end }]).map((range, rangeIndex) => {
                        const rangeStart = Math.max(0, finite(range?.start, start));
                        const rangeEnd = Math.max(rangeStart + 0.1, finite(range?.end, end));
                        return {
                            start: rangeStart,
                            end: rangeEnd,
                            name: label.slice(0, 24) + (label.length > 24 ? '…' : ''),
                            color: ov.disabled ? '#4b5563' : '#9333ea',
                            _timelineClipId: ov.id || `ov_${index}`,
                            _timelineRole: 'overlay',
                            _overlayId: ov.id,
                            _overlayRangeIndex: rangeIndex,
                            _overlayType: ov.type,
                            _fullText: ov.body_text || ov.title_text || ov.content || '',
                        };
                    }),
                };
            });
            tracks.unshift(...overlayTracks);
        }

        // 编辑器的最上方就是最终画面的最上层。插入轨与普通覆层轨都按同一
        // 合成顺序投影，避免“轨道已经换了位置，预览却没换”的错觉。
        const compositeOrder = getCompositedOverlays(task, options);
        const rank = new Map(compositeOrder.map((ov, index) => [
            ov._compositeOrderKey.startsWith('insert:') ? 'insert:track' : ov._compositeOrderKey,
            index,
        ]));
        const entryKey = (track) => track._overlayId ? `overlay:${track._overlayId}`
            : (track.role === 'insert_video' ? 'insert:track' : '');
        // 预览/导出会根据 overlayAboveSubtitle 决定“覆层（含插入素材）”和
        // 字幕的先后。时间线也必须使用完全相同的层级，否则会出现字幕轨在
        // 背景下面、但实际画面却盖在背景上的视觉误导。
        const overlayAboveSubtitle = task.overlayAboveSubtitle !== false;
        const layerRank = (track) => {
            const compositeRank = rank.get(entryKey(track));
            if (compositeRank != null) return (overlayAboveSubtitle ? 3000 : 1000) + compositeRank;
            if (track.type === 'subs') return 2000;
            return 0;
        };
        const indexed = tracks.map((track, index) => ({ track, index }));
        indexed.sort((a, b) => {
            const layerDelta = layerRank(b.track) - layerRank(a.track);
            if (layerDelta) return layerDelta; // 顶层在时间线最上方
            return a.index - b.index;
        });
        return indexed.map(item => item.track);
    }

    function applyEditorClip(task, editorClip, options = {}) {
        if (editorClip?._timelineRole === 'overlay' || editorClip?._overlayId) {
            const isCurrentTask = typeof window !== 'undefined'
                && window._reelsState?.tasks
                && window._reelsState.tasks[window._reelsState.selectedIdx] === task;
            const activeOverlays = (isCurrentTask && window._reelsState?.overlayProxy?.overlayMgr?.overlays) || task.overlays || [];
            const ov = activeOverlays.find(o => o.id === editorClip._overlayId || o.id === editorClip._timelineClipId);
            if (ov) {
                const newStart = Math.max(0, finite(editorClip.start));
                const newEnd = Math.max(newStart + 0.1, finite(editorClip.end));
                if (editorClip._overlayRangeIndex != null || Array.isArray(ov.display_ranges)) {
                    const ranges = Array.isArray(ov.display_ranges) && ov.display_ranges.length
                        ? ov.display_ranges.map(range => ({ ...range }))
                        : [{ start: finite(ov.start, 0), end: finite(ov.end, 5) }];
                    const rangeIndex = Math.max(0, Math.min(ranges.length - 1, Number(editorClip._overlayRangeIndex) || 0));
                    ranges[rangeIndex] = { start: newStart, end: newEnd };
                    ranges.sort((a, b) => a.start - b.start);
                    ov.display_ranges = ranges;
                    ov.start = ranges[0].start;
                    ov.end = ranges[ranges.length - 1].end;
                } else {
                    ov.start = newStart;
                    ov.end = newEnd;
                }
                if (isCurrentTask && typeof window !== 'undefined' && window._reelsState?.overlayProxy?.overlayMgr) {
                    if (typeof window._reelsState.overlayProxy.overlayMgr._notify === 'function') {
                        window._reelsState.overlayProxy.overlayMgr._notify();
                    }
                }
                if (typeof window !== 'undefined' && typeof window.reelsSaveHistory === 'function') {
                    window.reelsSaveHistory();
                }
                return true;
            }
            return false;
        }

        const timeline = ensureTimeline(task);
        const found = timeline && timeline.findClip(editorClip && editorClip._timelineClipId);
        if (!found) return false;
        const clip = found.clip;
        const newStart = Math.max(0, finite(editorClip.start));
        const newDuration = Math.max(0.05, finite(editorClip.end) - newStart);
        const role = clip._extra?.role || '';
        const isInsert = role === 'insert_video';
        const isSequencedBackground = role === 'background' || role === 'source_audio';
        const linked = timeline.linkedClips(clip);

        if (options.editMode === 'move') {
            if (isSequencedBackground) {
                // 循环背景移动/重排：
                // 如果用户拖放位置越过了相邻片段的中心（重排/插入），按顺序重新无缝平铺
                const peers = clipsByRole(timeline, role).sort((a, b) => a.startT - b.startT);
                const index = peers.indexOf(clip);
                const previousEnd = index > 0 ? peers[index - 1].startT + peers[index - 1].effectiveDuration : 0;
                const targetCenter = newStart + newDuration / 2;
                let shouldReorder = false;
                if (index > 0 && targetCenter < peers[index - 1].startT + peers[index - 1].effectiveDuration / 2) {
                    shouldReorder = true;
                } else if (index < peers.length - 1 && targetCenter > peers[index + 1].startT + peers[index + 1].effectiveDuration / 2) {
                    shouldReorder = true;
                }

                if (shouldReorder) {
                    peers.sort((a, b) => {
                        const cA = (a.id === clip.id ? targetCenter : (a.startT + a.effectiveDuration / 2));
                        const cB = (b.id === clip.id ? targetCenter : (b.startT + b.effectiveDuration / 2));
                        return cA - cB;
                    });
                    let currentT = 0;
                    for (const peer of peers) {
                        const peerLinked = timeline.linkedClips(peer);
                        const dur = peer.effectiveDuration;
                        peerLinked.forEach((item) => { item.startT = currentT; });
                        currentT += dur;
                    }
                } else {
                    const allowedStart = Math.max(previousEnd, newStart);
                    const delta = allowedStart - clip.startT;
                    if (delta) {
                        const excluded = linked.map((item) => item.id);
                        linked.forEach((item) => { item.startT = Math.max(0, item.startT + delta); });
                        // 只波纹移动当前轮之后的内容，不能把前一轮再次挪走。
                        timeline.rippleFrom(clip.startT + 0.0001, delta, { excludeClipIds: excluded, includeAtBoundary: false });
                    }
                }
            } else {
                const delta = newStart - clip.startT;
                linked.forEach((item) => {
                    item.startT = Math.max(0, item.startT + delta);
                });
            }
        } else if (options.editMode === 'cut_in') {
            const newInT = options.inT !== undefined ? options.inT : (editorClip.inT !== undefined ? editorClip.inT : clip.inT);
            for (const item of linked) {
                item.inT = Math.max(0, Math.min(item.outT - 0.05, newInT));
            }
        } else if (options.editMode === 'cut_out') {
            const newOutT = options.outT !== undefined ? options.outT : (editorClip.outT !== undefined ? editorClip.outT : clip.outT);
            for (const item of linked) {
                item.outT = Math.max(item.inT + 0.05, newOutT);
            }
        } else if (options.editMode === 'trim_start') {
            const localOffset = options.trimOffset != null
                ? options.trimOffset
                : (newStart - clip.startT);
            if (localOffset > 0) {
                const oldDuration = clip.effectiveDuration;
                const oldEnd = clip.startT + oldDuration;
                for (const item of linked) {
                    const baseIn = (options.origInT != null ? options.origInT : item.inT);
                    item.inT = Math.min(item.outT - 0.05, baseIn + localOffset * item.speed);
                    item.startT = newStart;
                }
                const newDurationAfter = clip.effectiveDuration;
                const delta = newDurationAfter - oldDuration;
                if (isSequencedBackground && delta) {
                    const excluded = linked.map((item) => item.id);
                    timeline.rippleFrom(oldEnd - 0.001, delta, { excludeClipIds: excluded, includeAtBoundary: true });
                }
            }
        } else if (options.editMode === 'trim_end') {
            const oldDuration = clip.effectiveDuration;
            const oldEnd = clip.startT + oldDuration;
            for (const item of linked) {
                const desiredDuration = Math.max(0.05, (newStart + newDuration) - item.startT);
                item.outT = Math.max(item.inT + 0.05, item.inT + desiredDuration * item.speed);
            }
            const delta = newDuration - oldDuration;
            if (delta && isSequencedBackground) {
                const excluded = linked.map((item) => item.id);
                timeline.rippleFrom(oldEnd - 0.001, delta, { excludeClipIds: excluded, includeAtBoundary: true });
            }
        } else {
            const delta = newStart - clip.startT;
            for (const item of linked) {
                item.startT = Math.max(0, item.startT + delta);
                item.outT = item.inT + newDuration * item.speed;
            }
        }

        if (isSequencedBackground) {
            const peers = clipsByRole(timeline, 'background').sort((a, b) => a.startT - b.startT);
            let prevEnd = 0;
            for (let i = 0; i < peers.length; i++) {
                const peer = peers[i];
                const peerLinked = timeline.linkedClips(peer);
                const dur = peer.effectiveDuration;
                if (peer.startT < prevEnd - 0.001) {
                    peerLinked.forEach((item) => {
                        item.startT = prevEnd;
                    });
                }
                prevEnd = peer.startT + dur;
                peerLinked.forEach((item) => {
                    item._extra = item._extra || {};
                    item._extra.sequenceIndex = i;
                    item._extra.loopIndex = i;
                });
            }
        }

        if (isInsert) {
            const item = (task.insertClips || []).find(value => value.id === clip._extra?.insertId);
            if (item) item.locked = true;
            syncInsertClipsFromTimeline(task, timeline);
        }

        syncLegacyFields(task);
        return true;
    }

    function syncInsertClipsFromTimeline(task, timeline = ensureTimeline(task)) {
        if (!timeline) return [];
        const existing = new Map((task.insertClips || []).map(item => [item.id, item]));
        const next = clipsByRole(timeline, 'insert_video').sort((a, b) => a.startT - b.startT).map((clip, index) => {
            const id = clip._extra?.insertId || `insert_${index + 1}`;
            const old = existing.get(id) || {};
            const duration = clip.effectiveDuration;
            return {
                ...old,
                id,
                sourcePath: timeline.sources[clip.sourceId]?.path || old.sourcePath || '',
                sourceType: old.sourceType || 'video',
                timelineStart: clip.startT,
                duration,
                sourceTrimStart: clip.inT,
                sourceTrimEnd: clip.outT,
                mode: old.mode || 'replace-video-keep-main-audio',
                audioMode: old.audioMode || 'keep-main',
                // 新建/旧项目未设置过音量时默认静音；已明确保存的值（包括 0）保留。
                volume: old.volume == null ? 0 : old.volume,
                transform: {
                    ...(old.transform || {}), x: clip.x, y: clip.y,
                    scale: Math.round(clip.scale * 100), rotation: clip.rotation,
                    fit: clip.fitMode, flipH: !!clip.flipX, flipV: !!clip.flipY,
                },
            };
        });
        task.insertClips = next;
        timeline._extra.insertClipKey = JSON.stringify(next.map(item => [item.id, item.sourcePath, item.timelineStart, item.duration, item.sourceTrimStart, item.sourceTrimEnd]));
        return next;
    }

    function addInsertClip(task, data = {}) {
        if (!task || !data.sourcePath) return null;
        task.insertClips = Array.isArray(task.insertClips) ? task.insertClips : [];
        const id = data.id || `insert_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const duration = Math.max(.05, finite(data.duration, 1.5));
        const sourceStart = Math.max(0, finite(data.sourceTrimStart));
        const item = {
            id, sourcePath: data.sourcePath, sourceType: data.sourceType || 'video',
            timelineStart: Math.max(0, finite(data.timelineStart)), duration,
            sourceTrimStart: sourceStart, sourceTrimEnd: finite(data.sourceTrimEnd, sourceStart + duration),
            sourceDuration: Math.max(0, finite(data.sourceDuration)),
            mode: data.mode || 'replace-video-keep-main-audio', audioMode: data.audioMode || 'keep-main',
            generatedBy: data.generatedBy || 'manual', locked: !!data.locked,
            volume: data.volume == null ? 0 : data.volume,
            transform: { x: 0, y: 0, scale: 100, rotation: 0, opacity: 100, fit: 'fill', ...(data.transform || {}) },
            transitionIn: data.transitionIn || { type: 'fade', duration: 0.35 },
            transitionOut: data.transitionOut || { type: 'fade', duration: 0.35 },
        };
        task.insertClips.push(item);
        const timeline = ensureTimeline(task);
        timeline._extra.insertClipKey = '';
        ensureLegacyTracks(timeline, task);
        return item;
    }

    // 将插入轨投影为既有 Overlay 渲染器支持的媒体覆层；预览、WYSIWYG 和
    // 分层导出因此共享同一套时间、裁切和画面变换规则。
    function getInsertOverlays(task, options = {}) {
        if (!task || task.insertClipsDisabled) return [];
        const canvasW = finite(options.width, 1080), canvasH = finite(options.height, 1920);
        return (task.insertClips || []).filter(item => item?.sourcePath && !item.disabled).map((item, index) => {
            const transform = item.transform || {};
            const isImage = item.sourceType === 'image' || /\.(png|jpe?g|webp)$/i.test(item.sourcePath);
            const start = Math.max(0, finite(item.timelineStart));
            const duration = Math.max(.05, finite(item.duration, 1.5));
            const mode = item.mode || 'replace-video-keep-main-audio';
            const pip = mode === 'pip' || mode === 'overlay';
            const baseW = transform.w != null ? finite(transform.w, Math.round(canvasW * .38)) : (pip ? Math.round(canvasW * .38) : canvasW);
            const baseH = transform.h != null ? finite(transform.h, Math.round(canvasH * .28)) : (pip ? Math.round(canvasH * .28) : canvasH);
            const defaultX = pip ? (canvasW - baseW - 48) : 0;
            const defaultY = pip ? (canvasH - baseH - 160) : 0;
            const animInType = item.transitionIn?.type !== undefined ? item.transitionIn.type : 'fade';
            const animOutType = item.transitionOut?.type !== undefined ? item.transitionOut.type : 'fade';
            const animInDur = finite(item.transitionIn?.duration, animInType !== 'none' ? 0.35 : 0);
            const animOutDur = finite(item.transitionOut?.duration, animOutType !== 'none' ? 0.35 : 0);
            return {
                id: `insert_overlay_${item.id || index}`, type: isImage ? 'image' : 'video',
                content: item.sourcePath, start, end: start + duration, _insertClip: true,
                video_start_offset: Math.max(0, finite(item.sourceTrimStart)),
                x: finite(transform.x, defaultX),
                y: finite(transform.y, defaultY),
                w: baseW, h: baseH, scale: finite(transform.scale, 100) / 100,
                rotation: finite(transform.rotation),
                // ReelsOverlay 的通用覆层透明度使用 0–255；插入素材编辑器
                // 使用用户可读的 0–100%。
                opacity: Math.max(0, Math.min(100, finite(transform.opacity, 100))) * 2.55,
                flip_x: !!transform.flipH, flip_y: !!transform.flipV,
                keep_aspect: transform.fit !== 'stretch', z_index: 9000 + index,
                anim_in_type: animInType,
                anim_out_type: animOutType,
                anim_in_duration: animInDur,
                anim_out_duration: animOutDur,
                disabled: false,
            };
        });
    }

    // 媒体插入和普通覆层虽然来自不同的编辑器，但最终都在同一张画布合成。
    // 这个顺序是唯一的合成事实：数组从底到顶，预览与导出均使用它。
    function getCompositedOverlays(task, options = {}) {
        const inserts = getInsertOverlays(task, options);
        const isCurrentTask = typeof window !== 'undefined'
            && window._reelsState?.tasks
            && window._reelsState.tasks[window._reelsState.selectedIdx] === task;
        // 导出时（options.forExport === true）或处理非界面当前选中任务时，
        // 必须严格使用 task.overlays，绝对禁止读取全局/其他任务的 overlayMgr！
        const base = ((!options?.forExport && isCurrentTask && window._reelsState?.overlayProxy?.overlayMgr?.overlays) || task?.overlays || [])
            .filter(ov => ov && !ov._insertClip);
        const entries = [
            ...inserts.map((ov, index) => ({ key: `insert:${ov.id}`, overlay: ov, fallback: index })),
            ...base.map((ov, index) => ({ key: `overlay:${ov.id || index}`, overlay: ov, fallback: inserts.length + index })),
        ];
        const keys = new Set(entries.map(entry => entry.key));
        const saved = Array.isArray(task?.visualOverlayOrder) ? task.visualOverlayOrder : [];
        const order = [...saved.filter(key => keys.has(key)), ...entries.map(entry => entry.key).filter(key => !saved.includes(key))];
        if (task && JSON.stringify(saved) !== JSON.stringify(order)) task.visualOverlayOrder = order;
        const rank = new Map(order.map((key, index) => [key, index]));
        return entries.sort((a, b) => rank.get(a.key) - rank.get(b.key)).map((entry, index) => ({
            ...entry.overlay,
            // 保留旧覆层已有 z 字段，同时给所有合成项一个统一且稳定的层级。
            z_index: 100 + index,
            _compositeOrderKey: entry.key,
        }));
    }

    function moveCompositedOverlay(task, first, second) {
        if (!task || !first || !second) return false;
        // 时间线编辑器可能传入重新投影过的轨道对象，轨道本身不一定保留
        // _overlayId，但它的片段仍带有该 ID。两者都取，确保上/下移真正写回覆层栈。
        const firstOverlayId = first._overlayId || first.clips?.find(clip => clip?._overlayId)?._overlayId;
        const secondOverlayId = second._overlayId || second.clips?.find(clip => clip?._overlayId)?._overlayId;
        const firstKey = firstOverlayId ? `overlay:${firstOverlayId}`
            : (first.role === 'insert_video' ? 'insert:track' : '');
        const secondKey = secondOverlayId ? `overlay:${secondOverlayId}`
            : (second.role === 'insert_video' ? 'insert:track' : '');
        // 插入素材是一条轨，任务中每段插入均随该轨一起改变层级。
        const keys = getCompositedOverlays(task).map(ov => ov._compositeOrderKey);
        const order = Array.isArray(task.visualOverlayOrder) ? [...task.visualOverlayOrder] : keys;
        const groupKeys = (key) => key === 'insert:track'
            ? order.filter(item => item.startsWith('insert:'))
            : [key];
        const firstGroup = groupKeys(firstKey), secondGroup = groupKeys(secondKey);
        if (!firstGroup.length || !secondGroup.length || firstGroup.some(key => secondGroup.includes(key))) return false;
        const firstIndex = order.indexOf(firstGroup[0]);
        const secondIndex = order.indexOf(secondGroup[0]);
        if (firstIndex < 0 || secondIndex < 0) return false;
        // 轨道是一整个插入组，不能因一次上下移动把多段插入素材拆散。
        const withoutFirst = order.filter(key => !firstGroup.includes(key));
        let targetIndex = withoutFirst.indexOf(secondGroup[0]);
        if (targetIndex < 0) return false;
        if (firstIndex < secondIndex) targetIndex += secondGroup.length;
        withoutFirst.splice(targetIndex, 0, ...firstGroup);
        task.visualOverlayOrder = withoutFirst;
        return true;
    }

    function fillBackgroundLoops(task, options = {}) {
        const timeline = ensureTimeline(task, options);
        if (!timeline) return false;
        const totalDuration = taskDuration(task, options);
        const videoTrack = trackFor(timeline, 'video', '背景视频（循环）', 'background');
        const audioTrack = trackFor(timeline, 'audio', '原声（绑定背景）', 'source_audio');
        const bgClips = clipsByRole(timeline, 'background').sort((a, b) => a.startT - b.startT);
        if (!bgClips.length) return false;

        const lastClip = bgClips[bgClips.length - 1];
        const lastEnd = lastClip.startT + lastClip.effectiveDuration;
        if (lastEnd >= totalDuration - 0.05) return false;

        const sourcePath = timeline.sources[lastClip.sourceId]?.path || task.bgPath || task.videoPath || '';
        const sourceDuration = timeline.sources[lastClip.sourceId]?.duration || (lastClip.outT - lastClip.inT) || 5;
        const baseLoopDur = Math.max(0.5, sourceDuration * (lastClip.speed || 1));

        let currentT = lastEnd;
        let loopIdx = (lastClip._extra?.loopIndex != null ? lastClip._extra.loopIndex : bgClips.length - 1) + 1;
        let addedCount = 0;

        while (currentT < totalDuration - 0.01) {
            const thisDur = Math.min(baseLoopDur, totalDuration - currentT);
            const sourceId = sourceFor(timeline, sourcePath, finite(sourceDuration, 5), 'background');
            const group = `bg_link_fill_${loopIdx}_${Math.round(currentT * 1000)}`;
            const video = new TimelineLib.Clip(sourceId, 0, thisDur * (lastClip.speed || 1), currentT);
            video.speed = lastClip.speed || 1;
            video.linkGroupId = group;
            video._extra.role = 'background';
            video._extra.sequenceIndex = loopIdx;
            video._extra.loopIndex = loopIdx;
            video._extra.transition = task.bgTransition || 'none';
            videoTrack.clips.push(video);

            const originalAudio = new TimelineLib.Clip(sourceId, 0, thisDur * (lastClip.speed || 1), currentT);
            originalAudio.speed = video.speed;
            originalAudio.linkGroupId = group;
            originalAudio.isMain = true;
            originalAudio._extra.role = 'source_audio';
            originalAudio._extra.sequenceIndex = loopIdx;
            originalAudio._extra.loopIndex = loopIdx;
            audioTrack.clips.push(originalAudio);

            currentT += thisDur;
            loopIdx++;
            addedCount++;
        }

        syncLegacyFields(task);
        return addedCount > 0;
    }

    const api = { ensureTimeline, syncLegacyFields, getEditorTracks, applyEditorClip, fillBackgroundLoops, syncInsertClipsFromTimeline, addInsertClip, getInsertOverlays, getCompositedOverlays, moveCompositedOverlay };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.ReelsRenderPlan = api;
})(typeof window !== 'undefined' ? window : globalThis);
