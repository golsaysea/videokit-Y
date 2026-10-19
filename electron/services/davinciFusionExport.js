/**
 * Resolve/Fusion hand-off package.
 *
 * FCPXML intentionally remains the source of truth for media placement.  The
 * generated Python script imports that timeline and creates real Text+ clips
 * for every word-timed subtitle, rather than baking the subtitles into PNGs.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

function finite(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function hex(value, fallback) {
    const raw = String(value || fallback || '#FFFFFF').split(',')[0].trim().replace('#', '');
    return /^([0-9a-f]{6})$/i.test(raw) ? `#${raw.toUpperCase()}` : fallback;
}

function normalizeStyle(input) {
    const s = JSON.parse(JSON.stringify(input || {}));
    const number = (key, fallback) => { s[key] = finite(s[key], fallback); };
    const colour = (key, fallback) => { s[key] = hex(s[key], fallback); };
    [
        ['fontsize', 74], ['font_weight', s.bold === false ? 400 : 700],
        ['letter_spacing', 0], ['line_spacing', 1.2], ['rotation', 0],
        ['border_width', 3], ['opacity_outline', 255], ['shadow_blur', 0],
        ['shadow_offset_x', 0], ['shadow_offset_y', 2], ['opacity_shadow', 0],
        ['opacity_bg', 180], ['box_radius', 8], ['box_blur', 0],
        ['box_padding_x', 12], ['box_padding_y', 8], ['pos_x', .5], ['pos_y', .5],
        ['wrap_width_percent', 90], ['wrap_lines', 2], ['opacity_text_global', 1],
        ['anim_in_duration', .3], ['anim_out_duration', .25], ['floating_amplitude', 8],
        ['floating_period', 2], ['char_bounce_height', 20], ['char_bounce_stagger', .05],
        ['metronome_bpm', 120], ['letter_jump_scale', 1.5], ['holy_glow_radius', 6],
        ['holy_glow_period', 3], ['blur_sharp_max', 20], ['blur_sharp_clear_frac', .4],
        ['flash_duration', .1], ['bullet_stagger', .15],
    ].forEach(([key, fallback]) => number(key, fallback));
    [
        ['color_text', '#FFFFFF'], ['color_high', '#FFD700'], ['color_outline', '#000000'],
        ['color_shadow', '#000000'], ['color_bg', '#000000'], ['flash_color', '#FFFFFF'],
        ['holy_glow_color', '#FFFFAA'],
    ].forEach(([key, fallback]) => colour(key, fallback));
    s.font_family = s.font_family || 'Arial';
    s.anim_in_type = s.anim_in_type || 'none';
    s.anim_out_type = s.anim_out_type || 'none';
    s.text_transform = s.text_transform || 'none';
    s.use_stroke = s.use_stroke !== false;
    s.use_box = !!s.use_box;
    s.karaoke_highlight = !!s.karaoke_highlight;
    s.italic = !!s.italic;
    return s;
}

function subtitleWordFrames(rawWords, displayText, cueStart, cueEnd, fps, transform) {
    const words = Array.isArray(rawWords) ? rawWords : [];
    if (!words.length) return [];
    const chars = Array.from(displayText);
    const searchable = chars.join('').toLocaleLowerCase();
    let cursor = 0;
    return words.map((raw) => {
        let token = String(raw?.display || raw?.word || raw?.text || '').trim();
        if (transform === 'uppercase') token = token.toUpperCase();
        if (transform === 'lowercase') token = token.toLowerCase();
        const tokenChars = Array.from(token);
        const found = tokenChars.length ? searchable.indexOf(token.toLocaleLowerCase(), cursor) : -1;
        const startIndex = found >= 0 ? Array.from(searchable.slice(0, found)).length : cursor;
        const endIndex = Math.max(startIndex, startIndex + tokenChars.length - 1);
        cursor = Math.max(cursor, endIndex + 1);
        const start = Math.max(cueStart, finite(raw?.start, cueStart));
        const end = Math.min(cueEnd, Math.max(start + 1 / fps, finite(raw?.end, start + .2)));
        return {
            start_index: startIndex,
            end_index: endIndex,
            start_frame: Math.max(0, Math.round((start - cueStart) * fps)),
            end_frame: Math.max(1, Math.round((end - cueStart) * fps)),
        };
    }).filter((word) => word.end_index >= word.start_index);
}

function buildCues(tasks, fps) {
    const cues = [];
    let timelineOffset = 0;
    for (const config of tasks || []) {
        const task = config.task || {};
        const style = normalizeStyle({ ...(config.style || {}), ...(task.subtitleStyle || {}) });
        let duration = finite(config.customDuration);
        if (!duration) {
            const start = finite(config.contentVideoTrimStart);
            const end = finite(config.contentVideoTrimEnd);
            const subtitleEnd = (config.segments || []).reduce((latest, segment) =>
                Math.max(latest, finite(segment?.end, 0)), 0);
            duration = end > start ? end - start : finite(task.duration, subtitleEnd || 5);
        }
        for (const seg of config.segments || []) {
            const cueStyle = normalizeStyle({
                ...(config.style || {}),
                ...(task.subtitleStyle || {}),
                ...(seg.style_override || seg.subtitle_style || {})
            });
            const start = timelineOffset + finite(seg.start);
            const end = timelineOffset + Math.max(finite(seg.end), finite(seg.start) + 1 / fps);
            let text = String(seg.edited_text || seg.text || '').trim();
            if (!text) continue;
            if (cueStyle.text_transform === 'uppercase') text = text.toUpperCase();
            else if (cueStyle.text_transform === 'lowercase') text = text.toLowerCase();
            const absoluteWords = (Array.isArray(seg.words) ? seg.words : []).map((word) => ({
                ...word,
                start: timelineOffset + finite(word?.start, seg.start),
                end: timelineOffset + finite(word?.end, seg.end),
            }));
            cues.push({
                start, end, text,
                words: subtitleWordFrames(absoluteWords, text, start, end, fps, cueStyle.text_transform),
                style: cueStyle,
            });
        }
        timelineOffset += Math.max(duration, 0);
    }
    return cues;
}

function pythonLiteral(value) { return JSON.stringify(value, null, 2); }

function xmlEscape(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function mediaDuration(filePath) {
    try {
        return Math.max(0, Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { encoding: 'utf8' }).trim()) || 0);
    } catch (_) { return 0; }
}

function writeNativeMediaTimeline(outputPath, tasks, fps, resolution) {
    const [width, height] = String(resolution || '1080x1920').split('x').map(Number);
    const rate = Math.max(1, Math.round(fps || 30));
    const frac = (seconds) => `${Math.max(0, Math.round(seconds * rate))}/${rate}s`;
    const items = [];
    for (const config of tasks || []) {
        const task = config.task || config || {};
        const videoPath = config.contentVideoPath || config.videoPath || task.videoPath || task.bgPath || '';
        const audioPath = config.audioPath || task.audioPath || '';
        const subtitleEnd = (config.segments || task.segments || []).reduce((max, seg) => Math.max(max, finite(seg?.end, 0)), 0);
        const targetDuration = finite(config.customDuration, 0) || subtitleEnd || finite(task.duration, 0);
        if (!videoPath || !fs.existsSync(videoPath) || targetDuration <= 0) continue;
        items.push({ videoPath, audioPath: fs.existsSync(audioPath) ? audioPath : '', targetDuration, videoDuration: mediaDuration(videoPath) || targetDuration, audioDuration: audioPath ? mediaDuration(audioPath) : 0, loopFadeDuration: Math.max(.1, Math.min(3, finite(config.loopFadeDur ?? task.loopFadeDur, 1))) });
    }
    if (!items.length) return null;
    const totalDuration = items.reduce((sum, item) => sum + item.targetDuration, 0);
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.9">\n\t<resources>\n`;
    xml += `\t\t<format id="r0" name="FFVideoFormat${height}p${rate}" frameDuration="1/${rate}s" width="${width || 1080}" height="${height || 1920}"/>\n`;
    items.forEach((item, index) => {
        xml += `\t\t<asset id="v${index}" name="${xmlEscape(path.basename(item.videoPath))}" src="${xmlEscape(pathToFileURL(item.videoPath).href)}" start="0/${rate}s" duration="${frac(item.videoDuration)}" hasVideo="1" hasAudio="1" format="r0"/>\n`;
        if (item.audioPath) xml += `\t\t<asset id="a${index}" name="${xmlEscape(path.basename(item.audioPath))}" src="${xmlEscape(pathToFileURL(item.audioPath).href)}" start="0/${rate}s" duration="${frac(item.audioDuration || item.targetDuration)}" hasVideo="0" hasAudio="1" audioSources="1" audioChannels="2"/>\n`;
    });
    xml += `\t\t<effect id="r101" name="Cross Dissolve" uid=".../Transitions.localized/Dissolve.localized/Cross Dissolve.localized/Cross Dissolve.motr"/>\n`;
    // Keep the main Resolve timeline clean: one compound clip per original
    // task. The necessary background loops remain inside that compound.
    items.forEach((item, index) => {
        let remaining = item.targetDuration; let local = 0;
        xml += `\t\t<media id="m${index}" name="${xmlEscape(path.basename(item.videoPath))}"><sequence format="r0" duration="${frac(item.targetDuration)}" tcStart="0/${rate}s" tcFormat="NDF"><spine><gap name="VideoKit Segment" offset="0/${rate}s" start="0/${rate}s" duration="${frac(item.targetDuration)}">\n`;
        while (remaining > .001) {
            const span = Math.min(item.videoDuration, remaining);
            if (local > 0) {
                const fade = Math.min(item.loopFadeDuration, span * .45, item.videoDuration * .45);
                xml += `\t\t\t<transition name="Cross Dissolve" offset="${frac(local - fade)}" duration="${frac(fade)}"><filter-video ref="r101" name="Cross Dissolve"/></transition>\n`;
            }
            xml += `\t\t\t<asset-clip name="${xmlEscape(path.basename(item.videoPath))}" ref="v${index}" lane="1" offset="${frac(local)}" start="0/${rate}s" duration="${frac(span)}" format="r0" tcFormat="NDF"/>\n`;
            local += span; remaining -= span;
        }
        if (item.audioPath) xml += `\t\t\t<asset-clip name="${xmlEscape(path.basename(item.audioPath))}" ref="a${index}" lane="-1" offset="0/${rate}s" start="0/${rate}s" duration="${frac(Math.min(item.targetDuration, item.audioDuration || item.targetDuration))}" tcFormat="NDF"/>\n`;
        xml += `\t\t</gap></spine></sequence></media>\n`;
    });
    xml += `\t</resources>\n\t<library><event name="VideoKit Native"><project name="${xmlEscape(path.basename(outputPath, '.fcpxml'))}"><sequence tcFormat="NDF" tcStart="0/${rate}s" duration="${frac(totalDuration)}" format="r0"><spine>\n`;
    let offset = 0;
    items.forEach((item, index) => {
        xml += `\t\t<ref-clip name="${xmlEscape(path.basename(item.videoPath))}" ref="m${index}" offset="${frac(offset)}" duration="${frac(item.targetDuration)}" srcEnable="all"/>\n`;
        offset += item.targetDuration;
    });
    xml += `\t</spine></sequence></project></event></library>\n</fcpxml>\n`;
    fs.writeFileSync(outputPath, xml, 'utf8');
    return outputPath;
}

function generateResolveScript(manifestPath) {
    // Dependency-free: Resolve executes this inside its own Python runtime.
    return `# VideoKit native Resolve/Fusion importer (generated; do not edit)
import json, os, traceback, math, tempfile

LOG = os.path.join(tempfile.gettempdir(), 'VideoKit Import Fusion.log')
def vlog(message):
    with open(LOG, 'a', encoding='utf-8') as f: f.write(str(message) + '\\n')
open(LOG, 'w', encoding='utf-8').write('VideoKit native Fusion import started\\n')
MANIFEST = ${JSON.stringify(String(manifestPath))}
with open(MANIFEST, 'r', encoding='utf-8') as f: data = json.load(f)

try:
    import DaVinciResolveScript as dvr
except ImportError:
    import fusionscript as dvr

resolve = globals().get('resolve') or dvr.scriptapp('Resolve')
if not resolve: raise RuntimeError('Resolve 脚本接口未连接。')
project = resolve.GetProjectManager().GetCurrentProject()
if not project: raise RuntimeError('请先在 Resolve 中打开一个项目。')
media_pool = project.GetMediaPool()
timeline = media_pool.ImportTimelineFromFile(data['fcpxml_path'], {'timelineName': data.get('timeline_name','VideoKit Native Fusion')})
if not timeline: raise RuntimeError('FCPXML 导入失败：' + data['fcpxml_path'])
project.SetCurrentTimeline(timeline)
# Resolve's title API follows the first unlocked video track. Reserve V2, then
# lock source V1 while titles are inserted; timecode alone cannot select V2.
try:
    while int(timeline.GetTrackCount('video') or 0) < 2: timeline.AddTrack('video')
    timeline.SetTrackName('video', 1, 'VIDEO')
    timeline.SetTrackName('video', 2, 'SUBTITLES')
    timeline.SetTrackLock('video', 1, True)
    vlog('V1 locked; native Text+ inserts target V2')
except Exception as e: vlog('V2 setup/lock skipped: %s' % e)
fps = float(data['fps'])
frame_w = float(data.get('width', 1080))
frame_h = float(data.get('height', 1920))

def rgb(h):
    h = (h or '#FFFFFF').lstrip('#')
    return (int(h[0:2],16)/255.0, int(h[2:4],16)/255.0, int(h[4:6],16)/255.0)

def put(tool, name, value):
    try: return tool.SetInput(name, value)
    except Exception as e:
        vlog('SetInput %s skipped: %s' % (name, e)); return False

def curve(comp, tool, name, keys):
    try:
        keyframes = {int(frame): {'Value': value, 'Flags': {'Linear': True}} for frame, value in keys}
        # Resolve's Python binding creates and connects the modifier in one
        # operation. Reading text.Blend afterwards returns None on Resolve 20.
        setattr(tool, name, comp.BezierSpline(keyframes))
        return True
    except Exception as e:
        vlog('animation %s skipped: %s' % (name, e))
        return False

def font_style(weight, italic):
    # Text+ silently falls back when a family does not expose "Black" or
    # "Extrabold" (Arial on macOS is the common case). Bold is portable.
    if weight >= 600: base = 'Bold'
    elif weight >= 500: base = 'Semibold'
    else: base = 'Regular'
    return base + (' Italic' if italic else '')

def resolve_font(family, weight):
    family = str(family or 'Arial')
    # macOS exposes the 900 face as its own family, not Arial's Style menu.
    if family.lower() == 'arial' and float(weight) >= 800: return 'Arial Black'
    return family

def make_sentence_plate(comp, text, cue, s, base_size, center):
    # A dedicated Text+ plate avoids the four-shading-layer limitation of a
    # single Text+. It is still a normal editable Fusion node.
    try:
        plate = comp.AddTool('TextPlus')
        if not plate: return False
        plate.SetAttrs({'TOOLS_Name':'VideoKit Subtitle Plate'})
        put(plate,'StyledText',cue['text']); put(plate,'Font',resolve_font(s.get('font_family','Arial'),s.get('font_weight',700)))
        put(plate,'Style',font_style(float(s.get('font_weight',700)),bool(s.get('italic',False))))
        put(plate,'Size',base_size); put(plate,'Center',center)
        put(plate,'HorizontalJustificationNew',3); put(plate,'VerticalJustificationNew',3)
        put(plate,'LineSpacing',float(s.get('line_spacing',1.2)))
        put(plate,'Enabled1',False); put(plate,'Enabled2',False); put(plate,'Enabled3',False)
        c=rgb(s.get('color_bg')); put(plate,'SelectElement',4); put(plate,'Enabled4',True)
        put(plate,'Element4',1); put(plate,'Type4',1); put(plate,'Level4',0)
        put(plate,'Red4',c[0]); put(plate,'Green4',c[1]); put(plate,'Blue4',c[2])
        put(plate,'Alpha4',1.0); put(plate,'Opacity4',float(s.get('opacity_bg',180))/255.0)
        ext_x=max(.08,float(s.get('box_padding_x',12))/float(s.get('fontsize',74))*.55)
        ext_y=max(.05,float(s.get('box_padding_y',8))/float(s.get('fontsize',74))*.38)
        roundness=min(1.0,float(s.get('box_radius',8))/20.0)
        put(plate,'ExtendHorizontal4',ext_x); put(plate,'ExtendVertical4',ext_y)
        put(plate,'ExtendX4',ext_x); put(plate,'ExtendY4',ext_y)
        put(plate,'Round4',roundness); put(plate,'Round4X',roundness); put(plate,'Round4Y',roundness)
        put(plate,'Softness4',0.0); put(plate,'SoftnessX4',0.0); put(plate,'SoftnessY4',0.0)
        merge=comp.AddTool('Merge')
        if not merge: return False
        merge.SetAttrs({'TOOLS_Name':'VideoKit Subtitle Merge'})
        merge.ConnectInput('Background',plate); merge.ConnectInput('Foreground',text)
        media_out=comp.FindToolByID('MediaOut') or comp.FindTool('MediaOut1')
        if media_out: media_out.ConnectInput('Input',merge)
        put(text,'Enabled4',False)
        return True
    except Exception as e:
        vlog('sentence plate fallback: %s' % e)
        return False

def native_word_highlight(comp, text, cue, base_rgb, high_rgb, rs):
    # CharacterLevelStyling is a native Fusion modifier: every cue stays a
    # Text+ title and every word colour change remains editable in Fusion.
    words = cue.get('words') or []
    if not words: return False
    try:
        text.AddModifier('StyledText', 'CharacterLevelStyling')
        output = text.StyledText.GetConnectedOutput()
        cls = output.GetTool() if output else None
        if not cls: return False
        cls.SetInput('Text', cue['text'])
        cls.SetInput('StyledText', cue['text'])
        cls.AddModifier('CharacterLevelStyling', 'BezierSpline')
        curve_output = cls.CharacterLevelStyling.GetConnectedOutput()
        spline = curve_output.GetTool() if curve_output else None
        if not spline: return False
        def style_array(active):
            values = []
            for i, word in enumerate(words):
                a, b = int(word['start_index']), int(word['end_index'])
                r,g,bv = high_rgb if i == active else base_rgb
                values.extend([
                    {1:2000, 2:a, 3:b, 'Value':1, 'Index':0, '__flags':256},
                    {1:2401, 2:a, 3:b, 'Value':r, 'Index':0, '__flags':256},
                    {1:2402, 2:a, 3:b, 'Value':g, 'Index':0, '__flags':256},
                    {1:2403, 2:a, 3:b, 'Value':bv, 'Index':0, '__flags':256},
                ])
            return values
        def key(index, array):
            return {'Value': {'__ctor':'StyledText', 'Array':array,
                    'Flags':{'StepIn':True,'StepOut':True,'LockedY':True,'__flags':256}}, 'Index':index}
        keys, key_index = {}, 0
        def put_key(frame, active):
            nonlocal key_index
            keys[int(rs + max(0,frame))] = key(key_index, style_array(active))
            key_index += 1
        first = max(0, int(words[0]['start_frame']))
        if first > 0:
            put_key(0, -1)
            put_key(first - 1, -1)
        for i, word in enumerate(words):
            start, end = int(word['start_frame']), max(int(word['start_frame'])+1, int(word['end_frame']))
            put_key(start, i)
            next_start = int(words[i+1]['start_frame']) if i+1 < len(words) else None
            if next_start is None: put_key(end, -1)
            elif end < next_start:
                put_key(end, -1)
                if next_start > end + 1: put_key(next_start - 1, -1)
            elif next_start > start + 1: put_key(next_start - 1, i)
        try: spline.SetKeyFrames(keys, True)
        except Exception: spline.SetKeyFrames(keys)
        return True
    except Exception as e:
        vlog('native word highlight skipped: %s' % e)
        return False

def apply_animation(comp, text, s, rs, re, base_size):
    kind = s.get('anim_in_type', 'none')
    n = max(1, int(round(float(s.get('anim_in_duration', .3)) * fps)))
    x, y = float(s.get('pos_x', .5)), 1.0 - float(s.get('pos_y', .5))
    blend_keys = []
    if kind == 'fade': blend_keys.extend([(rs, 0.0), (rs+n, 1.0)])
    elif kind in ('pop', 'letter_jump', 'word_pop_random', 'word_pop_random_pulse', 'char_bounce'):
        peak = float(s.get('letter_jump_scale', 1.15)) if kind == 'letter_jump' else 1.15
        curve(comp, text, 'Size', [(rs, base_size*.25), (rs+max(1,int(n*.65)), base_size*peak), (rs+n, base_size)])
    elif kind.startswith('slide_'):
        dx = -.10 if kind == 'slide_left' else (.10 if kind == 'slide_right' else 0)
        dy = .10 if kind == 'slide_up' else (-.10 if kind == 'slide_down' else 0)
        curve(comp, text, 'Center', [(rs, {1:x+dx,2:y+dy}), (rs+n, {1:x,2:y})])
        curve(comp, text, 'Blend', [(rs, 0.0), (rs+n, 1.0)])
    elif kind in ('typewriter', 'bullet_reveal'):
        curve(comp, text, 'WriteOnEnd', [(rs, 0.0), (rs+n, 1.0)])
    elif kind == 'blur_sharp':
        curve(comp, text, 'Softness1', [(rs, min(1.0,float(s.get('blur_sharp_max',20))/20.0)), (rs+n, 0.0)])
        curve(comp, text, 'Blend', [(rs, 0.0), (rs+n, 1.0)])
    elif kind == 'metronome':
        curve(comp, text, 'Angle', [(rs, -4.0), (rs+max(1,n//2), 4.0), (rs+n, 0.0)])
    elif kind == 'floating':
        amp = float(s.get('floating_amplitude',8))/frame_h
        period = max(2, int(round(float(s.get('floating_period',2))*fps)))
        keys=[]
        f=rs
        while f <= re:
            keys.extend([(f,{1:x,2:y}), (min(re,f+period//4),{1:x,2:y-amp}), (min(re,f+period//2),{1:x,2:y})])
            f += max(1,period//2)
        curve(comp, text, 'Center', keys)
    elif kind == 'holy_glow':
        put(text, 'Glow1', 1.0)
        curve(comp, text, 'Softness1', [(rs, 0.0), (rs+n//2, min(1.0,float(s.get('holy_glow_radius',6))/10.0)), (rs+n, 0.0)])
    elif kind == 'flash_highlight':
        curve(comp, text, 'Blend', [(rs,0.0),(rs+max(1,int(float(s.get('flash_duration',.1))*fps)),1.0)])

    out_kind = s.get('anim_out_type', 'none')
    out_n = max(1, int(round(float(s.get('anim_out_duration', .25)) * fps)))
    if out_kind == 'fade': blend_keys.extend([(max(rs,re-out_n), 1.0), (re, 0.0)])
    if blend_keys: curve(comp, text, 'Blend', blend_keys)

def timecode(frame):
    frame = max(0, int(frame)); rate = max(1, int(round(fps)))
    ff = frame % rate; total = frame // rate
    return '%02d:%02d:%02d:%02d' % (total//3600, (total//60)%60, total%60, ff)

def set_clip_span(item, start_frame, end_frame):
    duration = max(1, int(end_frame) - int(start_frame))
    try:
        inserted = item.GetStart()
        if inserted is not None:
            item.SetProperty('End', int(inserted) + duration)
            item.SetProperty('Duration', duration)
    except Exception as e: vlog('initial title trim skipped: %s' % e)
    put_item = lambda key, value: item.SetProperty(key, value)
    try: put_item('Start', int(start_frame))
    except Exception as e: vlog('clip start skipped: %s' % e)
    try: put_item('End', int(end_frame))
    except Exception as e: vlog('clip end skipped: %s' % e)
    try: put_item('Duration', duration)
    except Exception as e: vlog('clip duration skipped: %s' % e)

for index, cue in enumerate(data['fusion_cues']):
    start_frame = int(round(cue['start'] * fps))
    end_frame = max(start_frame + 1, int(round(cue['end'] * fps)))
    timeline.SetCurrentTimecode(timecode(start_frame))
    item = timeline.InsertFusionTitleIntoTimeline('Text+')
    if not item: raise RuntimeError('无法插入 Text+ Fusion 标题。')
    set_clip_span(item, start_frame, end_frame)
    try: vlog('cue %d timeline start=%s duration=%s' % (index+1, item.GetStart(), item.GetDuration()))
    except Exception: pass
    comp = item.GetFusionCompByIndex(1)
    tools = comp.GetToolList(False, 'TextPlus')
    text = next(iter(tools.values())) if tools else None
    if not text: continue
    s = cue['style']
    # Fusion's Text+ Size is based on the short canvas side, not the video
    # height. This matches the on-canvas 60px style in a 1080x1920 project.
    base_size = max(.040, min(.20, (float(s.get('fontsize',74))/min(frame_w,frame_h))*1.40))
    put(text, 'StyledText', cue['text'])
    put(text, 'Font', resolve_font(s.get('font_family','Arial'),s.get('font_weight',700)))
    put(text, 'Style', font_style(float(s.get('font_weight',700)), bool(s.get('italic',False))))
    put(text, 'Size', base_size)
    put(text, 'Center', {1:float(s.get('pos_x',.5)),2:1.0-float(s.get('pos_y',.5))})
    put(text, 'Angle', float(s.get('rotation',0)))
    put(text, 'HorizontalJustificationNew', 3)
    put(text, 'VerticalJustificationNew', 3)
    put(text, 'LineSpacing', float(s.get('line_spacing',1.2)))
    put(text, 'CharacterSpacing', 1.0 + float(s.get('letter_spacing',0))/max(1.0,float(s.get('fontsize',74))))
    c=rgb(s.get('color_text')); put(text,'SelectElement',1); put(text,'Enabled1',True); put(text,'Type1',0); put(text,'Red1',c[0]); put(text,'Green1',c[1]); put(text,'Blue1',c[2]); put(text,'Alpha1',1.0); put(text,'Opacity1',float(s.get('opacity_text_global',1))); put(text,'Softness1',0.0)

    stroke=bool(s.get('use_stroke',False)); put(text,'Enabled2',stroke)
    if stroke:
        c=rgb(s.get('color_outline')); put(text,'Type2',0); put(text,'Red2',c[0]); put(text,'Green2',c[1]); put(text,'Blue2',c[2]); put(text,'Alpha2',float(s.get('opacity_outline',255))/255.0); put(text,'Opacity2',float(s.get('opacity_outline',255))/255.0); put(text,'Thickness2',max(0.0,float(s.get('border_width',3))/100.0)); put(text,'OutsideOnly2',1)

    shadow=float(s.get('opacity_shadow',0)) > 0 or float(s.get('shadow_blur',0)) > 0
    put(text,'Enabled3',shadow)
    if shadow:
        c=rgb(s.get('color_shadow')); put(text,'Red3',c[0]); put(text,'Green3',c[1]); put(text,'Blue3',c[2]); put(text,'Alpha3',float(s.get('opacity_shadow',255))/255.0); put(text,'Softness3',min(1.0,float(s.get('shadow_blur',0))/20.0)); put(text,'Offset3',{1:float(s.get('shadow_offset_x',0))/frame_w,2:float(s.get('shadow_offset_y',2))/frame_h})

    box=bool(s.get('use_box',False)); put(text,'Enabled4',box)
    if box:
        c=rgb(s.get('color_bg')); put(text,'SelectElement',4); put(text,'Element4',1); put(text,'Type4',1); put(text,'Level4',0); put(text,'Red4',c[0]); put(text,'Green4',c[1]); put(text,'Blue4',c[2]); put(text,'Alpha4',1.0); put(text,'Opacity4',float(s.get('opacity_bg',180))/255.0); put(text,'ExtendHorizontal4',max(.08,float(s.get('box_padding_x',12))/float(s.get('fontsize',74))*.55)); put(text,'ExtendVertical4',max(.05,float(s.get('box_padding_y',8))/float(s.get('fontsize',74))*.38)); put(text,'Round4',min(1.0,float(s.get('box_radius',8))/20.0)); put(text,'Round4X',min(1.0,float(s.get('box_radius',8))/20.0)); put(text,'Round4Y',min(1.0,float(s.get('box_radius',8))/20.0)); put(text,'Softness4',0.0)

    attrs=comp.GetAttrs(); rs=int(attrs.get('COMPN_RenderStart',0)); re=rs+max(1,end_frame-start_frame-1)
    if s.get('karaoke_highlight'):
        native_word_highlight(comp,text,cue,rgb(s.get('color_text')),rgb(s.get('color_high')),rs)
    if box:
        make_sentence_plate(comp,text,cue,s,base_size,{1:float(s.get('pos_x',.5)),2:1.0-float(s.get('pos_y',.5))})
    apply_animation(comp,text,s,rs,re,base_size)
    vlog('%d/%d native Text+ %s' % (index+1,len(data['fusion_cues']),s.get('anim_in_type','none')))

vlog('success: %d editable native Fusion subtitles -> %s' % (len(data['fusion_cues']),timeline.GetName()))
try: timeline.SetTrackLock('video', 1, False)
except Exception: pass
print('VideoKit: imported %d editable native Fusion subtitles into %s' % (len(data['fusion_cues']),timeline.GetName()))
`;
}

function createFusionPackage({ outputDir, taskName, fcpxmlPath, tasks, fps = 30, resolution = '1080x1920', rebuildMediaTimeline = false }) {
    if (!fcpxmlPath || !fs.existsSync(fcpxmlPath)) throw new Error('FCPXML 文件不存在，无法生成 Resolve 包');
    const base = path.join(outputDir || path.dirname(fcpxmlPath), taskName || path.basename(fcpxmlPath, '.fcpxml'));
    // Batch jobs must stay independent. Putting every source task into one
    // Resolve timeline makes their media and subtitles impossible to align.
    if (rebuildMediaTimeline && Array.isArray(tasks) && tasks.length > 1) {
        const childScripts = [];
        let cueCount = 0;
        tasks.forEach((config, index) => {
            const childBase = `${base}_task_${String(index + 1).padStart(2, '0')}`;
            const nativePath = `${childBase}_native_media.fcpxml`;
            if (!writeNativeMediaTimeline(nativePath, [config], fps, resolution)) return;
            const match = String(resolution || '').match(/(\d+)\s*x\s*(\d+)/i);
            const width = match ? Number(match[1]) : 1080;
            const height = match ? Number(match[2]) : 1920;
            const cues = buildCues([config], finite(fps, 30));
            const manifestPath = `${childBase}_resolve_fusion.json`;
            const scriptPath = `${childBase}_import_fusion.py`;
            const taskLabel = config?.task?.baseName || config?.task?.exportName || config?.baseName || `Task ${index + 1}`;
            const manifest = {
                version: 4, fps: finite(fps, 30), width, height,
                timeline_name: `${taskName || 'VideoKit'} ${String(index + 1).padStart(2, '0')} ${String(taskLabel).slice(0, 36)}`,
                fcpxml_path: nativePath, fusion_cues: cues,
            };
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
            fs.writeFileSync(scriptPath, generateResolveScript(manifestPath), 'utf8');
            childScripts.push(scriptPath);
            cueCount += cues.length;
        });
        if (!childScripts.length) throw new Error('没有找到可导入的视频任务');
        const scriptPath = `${base}_import_fusion.py`;
        const master = `# VideoKit batch Resolve/Fusion importer\nimport traceback\nSCRIPTS = ${JSON.stringify(childScripts, null, 2)}\nfor index, script in enumerate(SCRIPTS, 1):\n    try:\n        print('VideoKit batch: importing %d/%d' % (index, len(SCRIPTS)))\n        with open(script, 'r', encoding='utf-8') as f: exec(compile(f.read(), script, 'exec'), globals())\n    except Exception:\n        traceback.print_exc()\n        raise\n`;
        fs.writeFileSync(scriptPath, master, 'utf8');
        return { manifest_path: `${base}_task_01_resolve_fusion.json`, script_path: scriptPath, fusion_cues: cueCount, timelines: childScripts.length };
    }
    const nativeTimelinePath = rebuildMediaTimeline ? `${base}_native_media.fcpxml` : null;
    const mediaTimelinePath = nativeTimelinePath ? writeNativeMediaTimeline(nativeTimelinePath, tasks, fps, resolution) : null;
    const manifestPath = `${base}_resolve_fusion.json`;
    const scriptPath = `${base}_import_fusion.py`;
    const match = String(resolution || '').match(/(\d+)\s*x\s*(\d+)/i);
    const width = match ? Number(match[1]) : 1080;
    const height = match ? Number(match[2]) : 1920;
    const timelineName = `${taskName || path.basename(fcpxmlPath, '.fcpxml')} ${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    const manifest = { version: 3, fps: finite(fps, 30), width, height, timeline_name: timelineName, fcpxml_path: mediaTimelinePath || fcpxmlPath, fusion_cues: buildCues(tasks, finite(fps, 30)) };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(scriptPath, generateResolveScript(manifestPath), 'utf8');
    return { manifest_path: manifestPath, script_path: scriptPath, fusion_cues: manifest.fusion_cues.length };
}

function installResolveMenuScript(scriptPath) {
    if (!scriptPath || typeof scriptPath !== 'string' || !scriptPath.endsWith('_import_fusion.py') || !fs.existsSync(scriptPath)) {
        throw new Error('Fusion 导入脚本不存在或路径无效');
    }
    // Keep the changing batch script in a user-owned dot-directory (~/.videokit/resolve)
    // outside macOS TCC-protected folders and not world-writable like /Users/Shared.
    const latestDir = path.join(os.homedir(), '.videokit', 'resolve');
    const latestScript = path.join(latestDir, 'VideoKit Import Fusion Latest.py');
    fs.mkdirSync(latestDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(scriptPath, latestScript);

    const sharedDir = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Comp';
    const sharedScript = path.join(sharedDir, 'VideoKit Import Fusion.py');
    const launcher = `# VideoKit Resolve launcher
import os, traceback, tempfile
latest = os.path.expanduser('~/.videokit/resolve/VideoKit Import Fusion Latest.py')
log = os.path.join(tempfile.gettempdir(), 'VideoKit Menu Launcher.log')
with open(log, 'w', encoding='utf-8') as f: f.write('launcher started\\n' + latest + '\\n')
try:
    if not os.path.isfile(latest): raise RuntimeError('请先从 VideoKit 导出 FCPXML 时间线。')
    with open(latest, 'r', encoding='utf-8') as f: code = compile(f.read(), latest, 'exec')
    exec(code, globals())
except Exception:
    with open(log, 'a', encoding='utf-8') as f: f.write(traceback.format_exc())
    raise
`;
    let needsInstall = true;
    try { needsInstall = fs.readFileSync(sharedScript, 'utf8') !== launcher; } catch (_) { /* install it */ }
    if (needsInstall && process.platform === 'darwin') {
        const tempLauncher = path.join(os.tmpdir(), 'videokit-resolve-launcher.py');
        fs.writeFileSync(tempLauncher, launcher, 'utf8');
        const command = `/usr/bin/install -d -m 755 ${JSON.stringify(sharedDir)} && /usr/bin/install -m 644 ${JSON.stringify(tempLauncher)} ${JSON.stringify(sharedScript)}`;
        execFileSync('osascript', ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`], { stdio: 'ignore' });
    }
    return { installed_path: sharedScript, latest_script_path: latestScript };
}

module.exports = { createFusionPackage, installResolveMenuScript };
