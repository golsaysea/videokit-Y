const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { GoogleGenAI } = require('@google/genai');
const settings = require('./settings');
const edgeTts = require('./edgeTts');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

// 30 Prebuilt Google Gemini TTS Voices (gemini-2.5-flash-preview-tts)
const GEMINI_VOICES = [
    // Female voices
    { ShortName: 'Zephyr', Gender: 'Female', Trait: '明亮清澈 (Bright)' },
    { ShortName: 'Kore', Gender: 'Female', Trait: '坚定自然 (Firm)' },
    { ShortName: 'Leda', Gender: 'Female', Trait: '年轻活力 (Youthful)' },
    { ShortName: 'Aoede', Gender: 'Female', Trait: '轻快自然 (Breezy)' },
    { ShortName: 'Callirrhoe', Gender: 'Female', Trait: '随和自然 (Easy-going)' },
    { ShortName: 'Autonoe', Gender: 'Female', Trait: '明亮温暖 (Bright)' },
    { ShortName: 'Despina', Gender: 'Female', Trait: '柔和顺滑 (Smooth)' },
    { ShortName: 'Erinome', Gender: 'Female', Trait: '清晰知性 (Clear)' },
    { ShortName: 'Laomedeia', Gender: 'Female', Trait: '欢快活泼 (Upbeat)' },
    { ShortName: 'Achernar', Gender: 'Female', Trait: '轻柔温婉 (Soft)' },
    { ShortName: 'Gacrux', Gender: 'Female', Trait: '成熟稳重 (Mature)' },
    { ShortName: 'Pulcherrima', Gender: 'Female', Trait: '清朗直接 (Forward)' },
    { ShortName: 'Vindemiatrix', Gender: 'Female', Trait: '温柔亲切 (Gentle)' },
    { ShortName: 'Sulafat', Gender: 'Female', Trait: '温暖治愈 (Warm)' },
    // Male voices
    { ShortName: 'Puck', Gender: 'Male', Trait: '欢快有活力 (Upbeat)' },
    { ShortName: 'Charon', Gender: 'Male', Trait: '沉稳播音 (Informative)' },
    { ShortName: 'Fenrir', Gender: 'Male', Trait: '激昂有力 (Excitable)' },
    { ShortName: 'Orus', Gender: 'Male', Trait: '坚定浑厚 (Firm)' },
    { ShortName: 'Enceladus', Gender: 'Male', Trait: '轻柔磁性 (Breathy)' },
    { ShortName: 'Iapetus', Gender: 'Male', Trait: '清晰磁性 (Clear)' },
    { ShortName: 'Umbriel', Gender: 'Male', Trait: '随和松弛 (Easy-going)' },
    { ShortName: 'Algieba', Gender: 'Male', Trait: '顺滑磁性 (Smooth)' },
    { ShortName: 'Algenib', Gender: 'Male', Trait: '低沉沙哑 (Gravelly)' },
    { ShortName: 'Rasalgethi', Gender: 'Male', Trait: '叙述解说 (Informative)' },
    { ShortName: 'Alnilam', Gender: 'Male', Trait: '坚定沉稳 (Firm)' },
    { ShortName: 'Schedar', Gender: 'Male', Trait: '平稳自然 (Even)' },
    { ShortName: 'Achird', Gender: 'Male', Trait: '亲切友好 (Friendly)' },
    { ShortName: 'Zubenelgenubi', Gender: 'Male', Trait: '随性自然 (Casual)' },
    { ShortName: 'Sadachbia', Gender: 'Male', Trait: '生动活泼 (Lively)' },
    { ShortName: 'Sadaltager', Gender: 'Male', Trait: '博学沉稳 (Knowledgeable)' },
];

// 24 Curated Gemini AI Persona & Scene Voices (Native Gemini 2.5 TTS + Acoustic Director Prompt)
const GEMINI_PERSONA_VOICES = [
    // Female Scene/Persona Voices (12)
    { id: 'Vindemiatrix_Prayer', baseVoice: 'Vindemiatrix', Gender: 'Female', Trait: '虔诚祈祷女声 (Prayer & Blessing)', prompt: 'Speak in a deeply reverent, warm, compassionate prayer and blessing tone with gentle pauses: ' },
    { id: 'Sulafat_Healing', baseVoice: 'Sulafat', Gender: 'Female', Trait: '心灵治愈女声 (Warm Healing)', prompt: 'Speak in a warm, soothing, comforting, emotionally healing tone: ' },
    { id: 'Kore_Scripture', baseVoice: 'Kore', Gender: 'Female', Trait: '圣经朗诵女声 (Scripture Reading)', prompt: 'Speak in a clear, solemn, faithful scripture-reading tone with measured pacing: ' },
    { id: 'Aoede_Story', baseVoice: 'Aoede', Gender: 'Female', Trait: '深情故事女声 (Emotional Storyteller)', prompt: 'Speak as an expressive, heartfelt storyteller with natural emotional dynamics: ' },
    { id: 'Despina_Bedtime', baseVoice: 'Despina', Gender: 'Female', Trait: '睡前哄睡女声 (Soft Bedtime)', prompt: 'Speak in a very soft, calm, tranquil bedtime whisper-warm tone: ' },
    { id: 'Leda_Reels', baseVoice: 'Leda', Gender: 'Female', Trait: '短视频爆款女声 (Viral Reels)', prompt: 'Speak in an engaging, crisp, captivating short-video narrator tone: ' },
    { id: 'Erinome_News', baseVoice: 'Erinome', Gender: 'Female', Trait: '新闻主播女声 (News Anchor)', prompt: 'Speak as a professional, articulate, authoritative broadcast news anchor: ' },
    { id: 'Gacrux_Documentary', baseVoice: 'Gacrux', Gender: 'Female', Trait: '纪录片知性女声 (Documentary)', prompt: 'Speak in a mature, thoughtful, cinematic documentary narrator tone: ' },
    { id: 'Zephyr_Commercial', baseVoice: 'Zephyr', Gender: 'Female', Trait: '品牌广告女声 (Bright Commercial)', prompt: 'Speak in a bright, polished, inspiring commercial voiceover tone: ' },
    { id: 'Achernar_Whisper', baseVoice: 'Achernar', Gender: 'Female', Trait: '空灵轻柔女声 (Gentle Whisper)', prompt: 'Speak in a delicate, breathy, intimate, gentle tone: ' },
    { id: 'Callirrhoe_Podcast', baseVoice: 'Callirrhoe', Gender: 'Female', Trait: '播客电台女声 (Cozy Podcast)', prompt: 'Speak in a relaxed, conversational, friendly podcast host tone: ' },
    { id: 'Autonoe_Audiobook', baseVoice: 'Autonoe', Gender: 'Female', Trait: '有声书旁白女声 (Audiobook)', prompt: 'Speak as a warm, engaging audiobook narrator with clear articulation: ' },
    // Male Scene/Persona Voices (12)
    { id: 'Orus_Pastor', baseVoice: 'Orus', Gender: 'Male', Trait: '庄重牧师祈祷男声 (Reverent Pastor)', prompt: 'Speak as a deep, solemn, compassionate pastor offering a heartfelt prayer and blessing: ' },
    { id: 'Charon_Bible', baseVoice: 'Charon', Gender: 'Male', Trait: '圣经浑厚旁白男声 (Biblical Narrator)', prompt: 'Speak in a resonant, timeless, authoritative biblical narrator voice: ' },
    { id: 'Fenrir_Trailer', baseVoice: 'Fenrir', Gender: 'Male', Trait: '史诗电影预告男声 (Epic Movie Trailer)', prompt: 'Speak in a powerful, dramatic, cinematic movie trailer voice: ' },
    { id: 'Algenib_Elder', baseVoice: 'Algenib', Gender: 'Male', Trait: '慈祥长者智者男声 (Wise Elder)', prompt: 'Speak as a wise, gentle, gravelly-voiced elder sharing life wisdom: ' },
    { id: 'Sadaltager_Doc', baseVoice: 'Sadaltager', Gender: 'Male', Trait: '大国纪录片男声 (Documentary Master)', prompt: 'Speak in a deep, knowledgeable, composed documentary narrator tone: ' },
    { id: 'Puck_Reels', baseVoice: 'Puck', Gender: 'Male', Trait: '短视频高能男声 (Viral Creator)', prompt: 'Speak in a punchy, energetic, hook-driven short-video creator tone: ' },
    { id: 'Algieba_Radio', baseVoice: 'Algieba', Gender: 'Male', Trait: '深夜电台磁性男声 (Late Night Radio)', prompt: 'Speak in a smooth, velvet, intimate late-night radio host voice: ' },
    { id: 'Iapetus_Anchor', baseVoice: 'Iapetus', Gender: 'Male', Trait: '权威新闻播音男声 (News Broadcast)', prompt: 'Speak as a crisp, steady, authoritative television news anchor: ' },
    { id: 'Enceladus_Gentle', baseVoice: 'Enceladus', Gender: 'Male', Trait: '温柔治愈男声 (Gentle Comfort)', prompt: 'Speak in a soft, breathy, reassuring, comforting male voice: ' },
    { id: 'Rasalgethi_Story', baseVoice: 'Rasalgethi', Gender: 'Male', Trait: '悬疑故事解说男声 (Suspense Story)', prompt: 'Speak as an intriguing, steady, immersive story and mystery narrator: ' },
    { id: 'Alnilam_Sermon', baseVoice: 'Alnilam', Gender: 'Male', Trait: '坚定布道演讲男声 (Inspiring Sermon)', prompt: 'Speak in a firm, uplifting, conviction-filled inspirational speaker tone: ' },
    { id: 'Achird_Podcast', baseVoice: 'Achird', Gender: 'Male', Trait: '温暖邻家青年男声 (Friendly Host)', prompt: 'Speak in a warm, natural, approachable conversational host tone: ' },
];

// 48 Flagship Google Cloud TTS Voices (Chirp3-HD / Studio / Journey / Neural2 / WaveNet)
// Uses Cloud TTS REST API if enabled on the key, or seamlessly falls back to native Gemini AI voice
const GOOGLE_CLOUD_VOICES = [
    // US English (en-US)
    { id: 'en-US-Chirp3-HD-Kore', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Chirp3-HD Kore · 超拟真美式女声', fallbackGemini: 'Kore' },
    { id: 'en-US-Chirp3-HD-Aoede', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Chirp3-HD Aoede · 超拟真轻快女声', fallbackGemini: 'Aoede' },
    { id: 'en-US-Chirp3-HD-Leda', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Chirp3-HD Leda · 超拟真活力女声', fallbackGemini: 'Leda' },
    { id: 'en-US-Chirp3-HD-Zephyr', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Chirp3-HD Zephyr · 超拟真清澈女声', fallbackGemini: 'Zephyr' },
    { id: 'en-US-Chirp3-HD-Puck', locale: 'en-US', gender: 'Male', label: '☁️ Cloud Chirp3-HD Puck · 超拟真活力男声', fallbackGemini: 'Puck' },
    { id: 'en-US-Chirp3-HD-Charon', locale: 'en-US', gender: 'Male', label: '☁️ Cloud Chirp3-HD Charon · 超拟真沉稳男声', fallbackGemini: 'Charon' },
    { id: 'en-US-Chirp3-HD-Fenrir', locale: 'en-US', gender: 'Male', label: '☁️ Cloud Chirp3-HD Fenrir · 超拟真激昂男声', fallbackGemini: 'Fenrir' },
    { id: 'en-US-Chirp3-HD-Orus', locale: 'en-US', gender: 'Male', label: '☁️ Cloud Chirp3-HD Orus · 超拟真浑厚男声', fallbackGemini: 'Orus' },
    { id: 'en-US-Journey-F', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Journey-F · 拟真叙事美式女声', fallbackGemini: 'Aoede' },
    { id: 'en-US-Journey-O', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Journey-O · 温暖对话美式女声', fallbackGemini: 'Sulafat' },
    { id: 'en-US-Journey-D', locale: 'en-US', gender: 'Male', label: '☁️ Cloud Journey-D · 磁性叙事美式男声', fallbackGemini: 'Charon' },
    { id: 'en-US-Studio-O', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Studio-O · 录音棚级播音女声', fallbackGemini: 'Erinome' },
    { id: 'en-US-Studio-Q', locale: 'en-US', gender: 'Male', label: '☁️ Cloud Studio-Q · 录音棚级播音男声', fallbackGemini: 'Iapetus' },
    { id: 'en-US-Neural2-C', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Neural2-C · 知性美式女声', fallbackGemini: 'Kore' },
    { id: 'en-US-Neural2-E', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Neural2-E · 温柔美式女声', fallbackGemini: 'Vindemiatrix' },
    { id: 'en-US-Neural2-F', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Neural2-F · 清亮美式女声', fallbackGemini: 'Zephyr' },
    { id: 'en-US-Neural2-G', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Neural2-G · 亲切美式女声', fallbackGemini: 'Callirrhoe' },
    { id: 'en-US-Neural2-H', locale: 'en-US', gender: 'Female', label: '☁️ Cloud Neural2-H · 甜美美式女声', fallbackGemini: 'Leda' },
    { id: 'en-US-Neural2-A', locale: 'en-US', gender: 'Male', label: '☁️ Cloud Neural2-A · 沉稳美式男声', fallbackGemini: 'Orus' },
    { id: 'en-US-Neural2-D', locale: 'en-US', gender: 'Male', label: '☁️ Cloud Neural2-D · 浑厚解说美式男声', fallbackGemini: 'Charon' },
    { id: 'en-US-Neural2-I', locale: 'en-US', gender: 'Male', label: '☁️ Cloud Neural2-I · 温和青年美式男声', fallbackGemini: 'Achird' },
    { id: 'en-US-Neural2-J', locale: 'en-US', gender: 'Male', label: '☁️ Cloud Neural2-J · 阳光播客美式男声', fallbackGemini: 'Puck' },
    // UK English (en-GB)
    { id: 'en-GB-Neural2-A', locale: 'en-GB', gender: 'Female', label: '☁️ Cloud Neural2-A · 优雅英式女声', fallbackGemini: 'Erinome' },
    { id: 'en-GB-Neural2-C', locale: 'en-GB', gender: 'Female', label: '☁️ Cloud Neural2-C · 知性英式女声', fallbackGemini: 'Gacrux' },
    { id: 'en-GB-Neural2-B', locale: 'en-GB', gender: 'Male', label: '☁️ Cloud Neural2-B · 绅士英式男声', fallbackGemini: 'Sadaltager' },
    { id: 'en-GB-Neural2-D', locale: 'en-GB', gender: 'Male', label: '☁️ Cloud Neural2-D · 浑厚英式男声', fallbackGemini: 'Orus' },
    // AU & IN English
    { id: 'en-AU-Neural2-A', locale: 'en-AU', gender: 'Female', label: '☁️ Cloud Neural2-A · 自然澳式女声', fallbackGemini: 'Aoede' },
    { id: 'en-AU-Neural2-B', locale: 'en-AU', gender: 'Male', label: '☁️ Cloud Neural2-B · 磁性澳式男声', fallbackGemini: 'Umbriel' },
    { id: 'en-IN-Neural2-A', locale: 'en-IN', gender: 'Female', label: '☁️ Cloud Neural2-A · 自然印式女声', fallbackGemini: 'Despina' },
    { id: 'en-IN-Neural2-B', locale: 'en-IN', gender: 'Male', label: '☁️ Cloud Neural2-B · 沉稳印式男声', fallbackGemini: 'Schedar' },
    // Chinese (zh-CN / zh-TW / zh-HK)
    { id: 'cmn-CN-Wavenet-A', locale: 'zh-CN', gender: 'Female', label: '☁️ Cloud WaveNet-A · 普通话甜美女声', fallbackGemini: 'Leda' },
    { id: 'cmn-CN-Wavenet-D', locale: 'zh-CN', gender: 'Female', label: '☁️ Cloud WaveNet-D · 普通话知性女声', fallbackGemini: 'Kore' },
    { id: 'cmn-CN-Wavenet-B', locale: 'zh-CN', gender: 'Male', label: '☁️ Cloud WaveNet-B · 普通话沉稳男声', fallbackGemini: 'Charon' },
    { id: 'cmn-CN-Wavenet-C', locale: 'zh-CN', gender: 'Male', label: '☁️ Cloud WaveNet-C · 普通话浑厚播音男声', fallbackGemini: 'Orus' },
    { id: 'cmn-TW-Wavenet-A', locale: 'zh-TW', gender: 'Female', label: '☁️ Cloud WaveNet-A · 台湾国语温柔女声', fallbackGemini: 'Vindemiatrix' },
    { id: 'cmn-TW-Wavenet-B', locale: 'zh-TW', gender: 'Male', label: '☁️ Cloud WaveNet-B · 台湾国语温和男声', fallbackGemini: 'Achird' },
    { id: 'yue-HK-Standard-A', locale: 'zh-HK', gender: 'Female', label: '☁️ Cloud Standard-A · 香港粤语自然女声', fallbackGemini: 'Callirrhoe' },
    { id: 'yue-HK-Standard-B', locale: 'zh-HK', gender: 'Male', label: '☁️ Cloud Standard-B · 香港粤语沉稳男声', fallbackGemini: 'Alnilam' },
    // Other Major Languages
    { id: 'es-ES-Neural2-A', locale: 'es-ES', gender: 'Female', label: '☁️ Cloud Neural2-A · 西班牙语女声', fallbackGemini: 'Aoede' },
    { id: 'es-ES-Neural2-B', locale: 'es-ES', gender: 'Male', label: '☁️ Cloud Neural2-B · 西班牙语男声', fallbackGemini: 'Orus' },
    { id: 'es-US-Neural2-A', locale: 'es-US', gender: 'Female', label: '☁️ Cloud Neural2-A · 美式西语女声', fallbackGemini: 'Sulafat' },
    { id: 'es-US-Neural2-B', locale: 'es-US', gender: 'Male', label: '☁️ Cloud Neural2-B · 美式西语男声', fallbackGemini: 'Charon' },
    { id: 'pt-BR-Neural2-A', locale: 'pt-BR', gender: 'Female', label: '☁️ Cloud Neural2-A · 巴西葡语女声', fallbackGemini: 'Kore' },
    { id: 'pt-BR-Neural2-B', locale: 'pt-BR', gender: 'Male', label: '☁️ Cloud Neural2-B · 巴西葡语男声', fallbackGemini: 'Orus' },
    { id: 'fr-FR-Neural2-A', locale: 'fr-FR', gender: 'Female', label: '☁️ Cloud Neural2-A · 法语优雅女声', fallbackGemini: 'Despina' },
    { id: 'fr-FR-Neural2-B', locale: 'fr-FR', gender: 'Male', label: '☁️ Cloud Neural2-B · 法语磁性男声', fallbackGemini: 'Algieba' },
    { id: 'de-DE-Neural2-F', locale: 'de-DE', gender: 'Female', label: '☁️ Cloud Neural2-F · 德语清晰女声', fallbackGemini: 'Erinome' },
    { id: 'de-DE-Neural2-B', locale: 'de-DE', gender: 'Male', label: '☁️ Cloud Neural2-B · 德语沉稳男声', fallbackGemini: 'Alnilam' },
    { id: 'ja-JP-Neural2-B', locale: 'ja-JP', gender: 'Female', label: '☁️ Cloud Neural2-B · 日语温柔女声', fallbackGemini: 'Achernar' },
    { id: 'ja-JP-Neural2-C', locale: 'ja-JP', gender: 'Male', label: '☁️ Cloud Neural2-C · 日语磁性男声', fallbackGemini: 'Iapetus' },
    { id: 'ko-KR-Neural2-A', locale: 'ko-KR', gender: 'Female', label: '☁️ Cloud Neural2-A · 韩语自然女声', fallbackGemini: 'Leda' },
    { id: 'ko-KR-Neural2-C', locale: 'ko-KR', gender: 'Male', label: '☁️ Cloud Neural2-C · 韩语沉稳男声', fallbackGemini: 'Schedar' },
];

// 52 Free keyless Google Translate TTS locales
const GOOGLE_TRANSLATE_VOICES = [
    { locale: 'en-US', tl: 'en-US', label: '英语 - 美国 (en-US)', shortLabel: '美式英语' },
    { locale: 'en-GB', tl: 'en-GB', label: '英语 - 英国 (en-GB)', shortLabel: '英式英语' },
    { locale: 'en-AU', tl: 'en-AU', label: '英语 - 澳大利亚 (en-AU)', shortLabel: '澳式英语' },
    { locale: 'en-CA', tl: 'en-CA', label: '英语 - 加拿大 (en-CA)', shortLabel: '加式英语' },
    { locale: 'en-IN', tl: 'en-IN', label: '英语 - 印度 (en-IN)', shortLabel: '印式英语' },
    { locale: 'en-IE', tl: 'en-IE', label: '英语 - 爱尔兰 (en-IE)', shortLabel: '爱尔兰英语' },
    { locale: 'en-ZA', tl: 'en-ZA', label: '英语 - 南非 (en-ZA)', shortLabel: '南非英语' },
    { locale: 'en-NZ', tl: 'en-NZ', label: '英语 - 新西兰 (en-NZ)', shortLabel: '新西兰英语' },
    { locale: 'en-SG', tl: 'en-SG', label: '英语 - 新加坡 (en-SG)', shortLabel: '新加坡英语' },
    { locale: 'en-NG', tl: 'en-NG', label: '英语 - 尼日利亚 (en-NG)', shortLabel: '尼日利亚英语' },
    { locale: 'zh-CN', tl: 'zh-CN', label: '中文 - 普通话 (zh-CN)', shortLabel: '普通话' },
    { locale: 'zh-TW', tl: 'zh-TW', label: '中文 - 台湾国语 (zh-TW)', shortLabel: '台湾国语' },
    { locale: 'zh-HK', tl: 'yue', label: '中文 - 香港粤语 (zh-HK)', shortLabel: '香港粤语' },
    { locale: 'es-ES', tl: 'es-ES', label: '西班牙语 - 西班牙 (es-ES)', shortLabel: '西班牙语(欧)' },
    { locale: 'es-MX', tl: 'es-MX', label: '西班牙语 - 墨西哥 (es-MX)', shortLabel: '西班牙语(墨)' },
    { locale: 'es-US', tl: 'es-US', label: '西班牙语 - 美国 (es-US)', shortLabel: '西班牙语(美)' },
    { locale: 'es-AR', tl: 'es-AR', label: '西班牙语 - 阿根廷 (es-AR)', shortLabel: '西班牙语(阿)' },
    { locale: 'es-CO', tl: 'es-CO', label: '西班牙语 - 哥伦比亚 (es-CO)', shortLabel: '西班牙语(哥)' },
    { locale: 'pt-BR', tl: 'pt-BR', label: '葡萄牙语 - 巴西 (pt-BR)', shortLabel: '葡萄牙语(巴)' },
    { locale: 'pt-PT', tl: 'pt-PT', label: '葡萄牙语 - 葡萄牙 (pt-PT)', shortLabel: '葡萄牙语(葡)' },
    { locale: 'fr-FR', tl: 'fr-FR', label: '法语 - 法国 (fr-FR)', shortLabel: '法语(法)' },
    { locale: 'fr-CA', tl: 'fr-CA', label: '法语 - 加拿大 (fr-CA)', shortLabel: '法语(加)' },
    { locale: 'de-DE', tl: 'de-DE', label: '德语 - 德国 (de-DE)', shortLabel: '德语' },
    { locale: 'it-IT', tl: 'it-IT', label: '意大利语 - 意大利 (it-IT)', shortLabel: '意大利语' },
    { locale: 'ja-JP', tl: 'ja-JP', label: '日语 - 日本 (ja-JP)', shortLabel: '日语' },
    { locale: 'ko-KR', tl: 'ko-KR', label: '韩语 - 韩国 (ko-KR)', shortLabel: '韩语' },
    { locale: 'ru-RU', tl: 'ru-RU', label: '俄语 - 俄罗斯 (ru-RU)', shortLabel: '俄语' },
    { locale: 'ar-SA', tl: 'ar', label: '阿拉伯语 (ar-SA)', shortLabel: '阿拉伯语' },
    { locale: 'hi-IN', tl: 'hi-IN', label: '印地语 - 印度 (hi-IN)', shortLabel: '印地语' },
    { locale: 'tl-PH', tl: 'tl', label: '菲律宾语 - 塔加洛语 (tl-PH)', shortLabel: '菲律宾语' },
    { locale: 'id-ID', tl: 'id-ID', label: '印尼语 - 印度尼西亚 (id-ID)', shortLabel: '印尼语' },
    { locale: 'ms-MY', tl: 'ms', label: '马来语 - 马来西亚 (ms-MY)', shortLabel: '马来语' },
    { locale: 'vi-VN', tl: 'vi-VN', label: '越南语 - 越南 (vi-VN)', shortLabel: '越南语' },
    { locale: 'th-TH', tl: 'th-TH', label: '泰语 - 泰国 (th-TH)', shortLabel: '泰语' },
    { locale: 'tr-TR', tl: 'tr-TR', label: '土耳其语 - 土耳其 (tr-TR)', shortLabel: '土耳其语' },
    { locale: 'pl-PL', tl: 'pl-PL', label: '波兰语 - 波兰 (pl-PL)', shortLabel: '波兰语' },
    { locale: 'nl-NL', tl: 'nl-NL', label: '荷兰语 - 荷兰 (nl-NL)', shortLabel: '荷兰语' },
    { locale: 'uk-UA', tl: 'uk', label: '乌克兰语 - 乌克兰 (uk-UA)', shortLabel: '乌克兰语' },
    { locale: 'el-GR', tl: 'el', label: '希腊语 - 希腊 (el-GR)', shortLabel: '希腊语' },
    { locale: 'cs-CZ', tl: 'cs', label: '捷克语 - 捷克 (cs-CZ)', shortLabel: '捷克语' },
    { locale: 'sv-SE', tl: 'sv', label: '瑞典语 - 瑞典 (sv-SE)', shortLabel: '瑞典语' },
    { locale: 'da-DK', tl: 'da', label: '丹麦语 - 丹麦 (da-DK)', shortLabel: '丹麦语' },
    { locale: 'fi-FI', tl: 'fi', label: '芬兰语 - 芬兰 (fi-FI)', shortLabel: '芬兰语' },
    { locale: 'nb-NO', tl: 'no', label: '挪威语 - 挪威 (nb-NO)', shortLabel: '挪威语' },
    { locale: 'he-IL', tl: 'iw', label: '希伯来语 - 以色列 (he-IL)', shortLabel: '希伯来语' },
    { locale: 'hu-HU', tl: 'hu', label: '匈牙利语 - 匈牙利 (hu-HU)', shortLabel: '匈牙利语' },
    { locale: 'ro-RO', tl: 'ro', label: '罗马尼亚语 - 罗马尼亚 (ro-RO)', shortLabel: '罗马尼亚语' },
    { locale: 'bn-IN', tl: 'bn', label: '孟加拉语 (bn-IN)', shortLabel: '孟加拉语' },
    { locale: 'ta-IN', tl: 'ta', label: '泰米尔语 (ta-IN)', shortLabel: '泰米尔语' },
    { locale: 'te-IN', tl: 'te', label: '泰卢固语 (te-IN)', shortLabel: '泰卢固语' },
    { locale: 'ur-PK', tl: 'ur', label: '乌尔都语 (ur-PK)', shortLabel: '乌尔都语' },
    { locale: 'sw-KE', tl: 'sw', label: '斯瓦希里语 (sw-KE)', shortLabel: '斯瓦希里语' },
];

// 20 Multi-Voice Timbre Presets (10 Female + 10 Male) for Keyless Google Translate TTS
const GOOGLE_TRANSLATE_VOICE_PRESETS = [
    // Female voices (10)
    {
        key: 'default',
        name: '标准自然女声 (Standard)',
        gender: 'Female',
        pitch: 1.0,
        tempo: 1.0,
        formant: 'shifted',
        eq: '',
    },
    {
        key: 'female_warm',
        name: '温柔治愈女声 (Warm & Gentle)',
        gender: 'Female',
        pitch: 0.95,
        tempo: 0.95,
        formant: 'shifted',
        eq: 'equalizer=f=220:t=q:w=1.2:g=2.5,equalizer=f=4500:t=q:w=1.5:g=-2',
    },
    {
        key: 'female_prayer',
        name: '虔诚祷告女声 (Prayer & Blessing)',
        gender: 'Female',
        pitch: 0.93,
        tempo: 0.91,
        formant: 'shifted',
        eq: 'equalizer=f=200:t=q:w=1.2:g=3,equalizer=f=4000:t=q:w=1.5:g=-2.5',
    },
    {
        key: 'female_bright',
        name: '清亮活力少女 (Bright & Youthful)',
        gender: 'Female',
        pitch: 1.07,
        tempo: 1.03,
        formant: 'shifted',
        eq: 'equalizer=f=3500:t=q:w=1.2:g=2',
    },
    {
        key: 'female_sweet',
        name: '甜美亲切女声 (Sweet & Friendly)',
        gender: 'Female',
        pitch: 1.04,
        tempo: 0.98,
        formant: 'shifted',
        eq: 'equalizer=f=280:t=q:w=1.3:g=1.8,equalizer=f=3200:t=q:w=1.3:g=1.5',
    },
    {
        key: 'female_calm',
        name: '知性沉稳女声 (Calm Narrator)',
        gender: 'Female',
        pitch: 0.92,
        tempo: 0.94,
        formant: 'shifted',
        eq: 'equalizer=f=190:t=q:w=1.1:g=2,equalizer=f=3800:t=q:w=1.4:g=-1.5',
    },
    {
        key: 'female_story',
        name: '深情故事女声 (Storyteller)',
        gender: 'Female',
        pitch: 0.97,
        tempo: 0.92,
        formant: 'preserved',
        eq: 'equalizer=f=250:t=q:w=1.2:g=2,equalizer=f=2800:t=q:w=1.5:g=1.5',
    },
    {
        key: 'female_crisp',
        name: '清晰播音女声 (Crisp Broadcast)',
        gender: 'Female',
        pitch: 1.02,
        tempo: 1.02,
        formant: 'preserved',
        eq: 'equalizer=f=160:t=q:w=1.2:g=1.5,equalizer=f=4200:t=q:w=1.3:g=2.5',
    },
    {
        key: 'female_soft',
        name: '空灵轻柔女声 (Soft & Ethereal)',
        gender: 'Female',
        pitch: 1.03,
        tempo: 0.90,
        formant: 'preserved',
        eq: 'equalizer=f=240:t=q:w=1.2:g=2,equalizer=f=5000:t=q:w=1.4:g=-2',
    },
    {
        key: 'female_elder',
        name: '慈祥长者女声 (Kind Grandmother)',
        gender: 'Female',
        pitch: 0.89,
        tempo: 0.89,
        formant: 'shifted',
        eq: 'equalizer=f=175:t=q:w=1.2:g=2.5,equalizer=f=3600:t=q:w=1.4:g=-2.5',
    },
    // Male voices (10)
    {
        key: 'male_calm',
        name: '沉稳解说男声 (Calm Narrator)',
        gender: 'Male',
        pitch: 0.82,
        tempo: 0.97,
        formant: 'shifted',
        eq: 'equalizer=f=135:t=q:w=1.1:g=3.5,equalizer=f=3200:t=q:w=1.5:g=-2.5',
    },
    {
        key: 'male_deep',
        name: '浑厚磁性男声 (Deep Baritone)',
        gender: 'Male',
        pitch: 0.77,
        tempo: 0.95,
        formant: 'shifted',
        eq: 'equalizer=f=115:t=q:w=1.0:g=4.5,equalizer=f=280:t=q:w=1.4:g=2,equalizer=f=3400:t=q:w=1.4:g=-3',
    },
    {
        key: 'male_pastor',
        name: '庄重祈祷男声 (Reverent Pastor)',
        gender: 'Male',
        pitch: 0.79,
        tempo: 0.91,
        formant: 'shifted',
        eq: 'equalizer=f=125:t=q:w=1.1:g=4,equalizer=f=240:t=q:w=1.3:g=2,equalizer=f=3500:t=q:w=1.5:g=-2.5',
    },
    {
        key: 'male_warm',
        name: '温和青年男声 (Warm Tenor)',
        gender: 'Male',
        pitch: 0.86,
        tempo: 0.99,
        formant: 'shifted',
        eq: 'equalizer=f=160:t=q:w=1.2:g=2.5,equalizer=f=3000:t=q:w=1.5:g=-1.5',
    },
    {
        key: 'male_youth',
        name: '阳光活力少年 (Bright Youth Male)',
        gender: 'Male',
        pitch: 0.89,
        tempo: 1.03,
        formant: 'shifted',
        eq: 'equalizer=f=175:t=q:w=1.2:g=2,equalizer=f=2900:t=q:w=1.4:g=1',
    },
    {
        key: 'male_broadcast',
        name: '铿锵播音男声 (Broadcast Anchor)',
        gender: 'Male',
        pitch: 0.84,
        tempo: 1.02,
        formant: 'shifted',
        eq: 'equalizer=f=145:t=q:w=1.2:g=3,equalizer=f=2600:t=q:w=1.3:g=1.5',
    },
    {
        key: 'male_trailer',
        name: '史诗电影男声 (Epic Trailer)',
        gender: 'Male',
        pitch: 0.74,
        tempo: 0.92,
        formant: 'shifted',
        eq: 'equalizer=f=105:t=q:w=1.0:g=5,equalizer=f=250:t=q:w=1.3:g=2.5,equalizer=f=3300:t=q:w=1.4:g=-3',
    },
    {
        key: 'male_radio',
        name: '深夜电台男声 (Late Night Radio)',
        gender: 'Male',
        pitch: 0.80,
        tempo: 0.93,
        formant: 'shifted',
        eq: 'equalizer=f=130:t=q:w=1.1:g=4,equalizer=f=3600:t=q:w=1.5:g=-2.8',
    },
    {
        key: 'male_doc',
        name: '纪录片旁白男声 (Documentary)',
        gender: 'Male',
        pitch: 0.81,
        tempo: 0.95,
        formant: 'shifted',
        eq: 'equalizer=f=140:t=q:w=1.1:g=3.2,equalizer=f=2800:t=q:w=1.4:g=-1.5',
    },
    {
        key: 'male_elder',
        name: '慈祥长者男声 (Wise Elder)',
        gender: 'Male',
        pitch: 0.75,
        tempo: 0.89,
        formant: 'shifted',
        eq: 'equalizer=f=120:t=q:w=1.1:g=3.5,equalizer=f=220:t=q:w=1.2:g=2.5,equalizer=f=3600:t=q:w=1.4:g=-3.5',
    },
];

function buildVoiceList() {
    const list = [];
    // 1. 30 Official Prebuilt Gemini 2.5 Native Voices
    for (const gv of GEMINI_VOICES) {
        list.push({
            voice_id: `gemini:${gv.ShortName}`,
            ShortName: gv.ShortName,
            engine: 'gemini',
            name: `Gemini ${gv.ShortName} · ${gv.Trait}`,
            FriendlyName: `Google Gemini ${gv.ShortName} (${gv.Trait})`,
            LocalName: `✨ Gemini ${gv.ShortName} · ${gv.Trait}`,
            DisplayName: `Gemini ${gv.ShortName}`,
            locale: 'multi',
            Locale: 'multi',
            gender: gv.Gender,
            Gender: gv.Gender,
            trait: gv.Trait,
        });
    }
    // 2. 24 Curated Gemini AI Scene & Persona Voices
    for (const pv of GEMINI_PERSONA_VOICES) {
        list.push({
            voice_id: `gemini:${pv.id}`,
            ShortName: pv.id,
            engine: 'gemini',
            name: `Gemini 场景定制 · ${pv.Trait}`,
            FriendlyName: `Google Gemini Persona ${pv.id} (${pv.Trait})`,
            LocalName: `🎭 Gemini 定制 · ${pv.Trait} [${pv.baseVoice}]`,
            DisplayName: `Gemini ${pv.Trait}`,
            locale: 'multi',
            Locale: 'multi',
            gender: pv.Gender,
            Gender: pv.Gender,
            trait: pv.Trait,
        });
    }
    // 3. Flagship Google Cloud TTS Voices (Chirp3-HD / Studio / Journey / Neural2 / WaveNet)
    for (const cv of GOOGLE_CLOUD_VOICES) {
        list.push({
            voice_id: `cloud:${cv.id}`,
            ShortName: cv.id,
            engine: 'gemini',
            name: cv.label,
            FriendlyName: `${cv.label} (${cv.locale})`,
            LocalName: cv.label,
            DisplayName: cv.label,
            locale: cv.locale,
            Locale: cv.locale,
            gender: cv.gender,
            Gender: cv.gender,
            trait: cv.label,
        });
    }
    // 4. 52 Locales x 20 Female & Male Keyless Google Translate Voices (1,040 voices)
    for (const tv of GOOGLE_TRANSLATE_VOICES) {
        const shortLoc = tv.shortLabel || tv.label;
        for (const preset of GOOGLE_TRANSLATE_VOICE_PRESETS) {
            const voiceId = preset.key === 'default'
                ? `gtrans:${tv.locale}`
                : `gtrans:${tv.locale}:${preset.key}`;
            list.push({
                voice_id: voiceId,
                ShortName: preset.key === 'default' ? `Google-${tv.locale}` : `Google-${tv.locale}-${preset.key}`,
                engine: 'translate',
                name: `Google 免Key · ${shortLoc} · ${preset.name}`,
                FriendlyName: `Google Translate (${tv.label}) - ${preset.name}`,
                LocalName: `🌐 ${shortLoc} · ${preset.name}`,
                DisplayName: `${shortLoc} · ${preset.name}`,
                locale: tv.locale,
                Locale: tv.locale,
                tl: tv.tl,
                gender: preset.gender,
                Gender: preset.gender,
                trait: preset.name,
                presetKey: preset.key,
            });
        }
    }
    return list;
}

function getUsableGeminiTtsKeys() {
    const geminiData = settings.loadGeminiKeys?.() || { keys: [], tts_keys: [] };
    const combined = [
        ...(Array.isArray(geminiData.tts_keys) ? geminiData.tts_keys : []),
        ...(Array.isArray(geminiData.keys) ? geminiData.keys : []),
    ].map(k => String(k || '').trim()).filter(Boolean);
    return [...new Set(combined)];
}

async function listVoices() {
    const usableKeys = getUsableGeminiTtsKeys();
    const geminiData = settings.loadGeminiKeys?.() || {};
    return {
        voices: buildVoiceList(),
        geminiKeyCount: usableKeys.length,
        ttsKeys: Array.isArray(geminiData.tts_keys) && geminiData.tts_keys.length ? geminiData.tts_keys : usableKeys,
        ttsModel: geminiData.tts_model || 'gemini-2.5-flash-preview-tts',
        status: 'ok',
    };
}

function formatSrtTimestamp(totalMs) {
    const clamped = Math.max(0, Math.round(Number(totalMs) || 0));
    const hours = Math.floor(clamped / 3600000);
    const minutes = Math.floor((clamped % 3600000) / 60000);
    const seconds = Math.floor((clamped % 60000) / 1000);
    const millis = clamped % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function buildSrtFromText(text, totalDurationSec = 0) {
    const clean = String(text || '').trim();
    if (!clean) return '';
    const sentences = clean.split(/(?<=[.!?。！？；;\n])\s*/).map(s => s.trim()).filter(Boolean);
    if (!sentences.length) {
        const endMs = Math.max(1500, Math.round((totalDurationSec || 3) * 1000));
        return `1\n00:00:00,000 --> ${formatSrtTimestamp(endMs)}\n${clean}\n`;
    }
    const weights = sentences.map(s => Math.max(1, Array.from(s).filter(c => !/\s/.test(c)).length));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const totalMs = totalDurationSec > 0.2
        ? Math.round(totalDurationSec * 1000)
        : Math.max(1500, totalWeight * 160);

    let cursorMs = 0;
    return sentences.map((line, idx) => {
        const durMs = idx === sentences.length - 1
            ? Math.max(300, totalMs - cursorMs)
            : Math.max(400, Math.round((weights[idx] / totalWeight) * totalMs));
        const start = formatSrtTimestamp(cursorMs);
        cursorMs += durMs;
        const end = formatSrtTimestamp(cursorMs);
        return `${idx + 1}\n${start} --> ${end}\n${line}\n`;
    }).join('\n');
}

function splitTextIntoChunks(text, maxChars = 180) {
    const clean = String(text || '').trim();
    if (!clean) return [];
    const rawParts = clean.split(/(?<=[.!?。！？；;\n])\s*/).map(s => s.trim()).filter(Boolean);
    const chunks = [];
    let current = '';
    for (const part of rawParts) {
        if ((current + ' ' + part).trim().length <= maxChars) {
            current = (current + ' ' + part).trim();
        } else {
            if (current) chunks.push(current);
            if (part.length <= maxChars) {
                current = part;
            } else {
                for (let i = 0; i < part.length; i += maxChars) {
                    chunks.push(part.slice(i, i + maxChars));
                }
                current = '';
            }
        }
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [clean.slice(0, maxChars)];
}

function fetchHttpsBuffer(url, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: timeoutMs }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                fetchHttpsBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.on('error', reject);
    });
}

function wrapPcm16ToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // PCM chunk size
    header.writeUInt16LE(1, 20);  // AudioFormat = 1 (PCM)
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcmBuffer]);
}

const TRANSLATE_STYLE_MODIFIERS = {
    natural: { pitch: 1.0, tempo: 1.0, eq: '' },
    calm: { pitch: 0.98, tempo: 0.94, eq: 'equalizer=f=170:t=q:w=1.2:g=1.5' },
    upbeat: { pitch: 1.02, tempo: 1.05, eq: 'equalizer=f=3200:t=q:w=1.3:g=1.5' },
    narrative: { pitch: 0.99, tempo: 0.96, eq: 'equalizer=f=220:t=q:w=1.2:g=1.2' },
    gentle: { pitch: 0.99, tempo: 0.93, eq: 'equalizer=f=4000:t=q:w=1.4:g=-1.8' },
};

async function convertToMp3WithSpeed(inputBuffer, inputExt = '.wav', rateStr = '+0%', preset = null, style = 'natural') {
    const ratePct = parseInt(String(rateStr || '+0%'), 10) || 0;
    const userTempo = Math.max(0.5, Math.min(2.0, 1 + ratePct / 100));
    const styleMod = (preset && TRANSLATE_STYLE_MODIFIERS[style]) || TRANSLATE_STYLE_MODIFIERS.natural;
    const pitch = Math.max(0.55, Math.min(1.6, (preset?.pitch || 1.0) * (styleMod.pitch || 1.0)));
    const tempo = Math.max(0.5, Math.min(2.0, userTempo * (preset?.tempo || 1.0) * (styleMod.tempo || 1.0)));
    const formant = preset?.formant === 'preserved' ? 'preserved' : 'shifted';
    const eqParts = [preset?.eq || '', styleMod.eq || ''].filter(Boolean);

    const needsProcessing = Math.abs(pitch - 1.0) > 0.008 || Math.abs(tempo - 1.0) > 0.008 || eqParts.length > 0 || inputExt !== '.mp3';
    if (!needsProcessing) {
        return inputBuffer;
    }

    const tmpIn = settings.secureTmpFile('gg_tts_in', inputExt);
    const tmpOut = settings.secureTmpFile('gg_tts_out', '.mp3');
    try {
        await fs.promises.writeFile(tmpIn, inputBuffer);
        const ffmpeg = require('./ffmpeg');

        const buildArgs = (useRubberband) => {
            const filters = [];
            if (Math.abs(pitch - 1.0) > 0.008) {
                if (useRubberband) {
                    filters.push(`rubberband=pitch=${pitch.toFixed(4)}:tempo=${tempo.toFixed(4)}:formant=${formant}:pitchq=quality:transients=crisp`);
                } else {
                    const compTempo = Math.max(0.5, Math.min(2.0, tempo / pitch));
                    filters.push(`asetrate=24000*${pitch.toFixed(4)}`, 'aresample=44100', `atempo=${compTempo.toFixed(4)}`);
                }
            } else if (Math.abs(tempo - 1.0) > 0.008) {
                filters.push(`atempo=${tempo.toFixed(3)}`);
            }
            if (eqParts.length) {
                filters.push(...eqParts);
            }
            filters.push('aresample=44100');
            const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', tmpIn];
            if (filters.length) {
                args.push('-filter:a', filters.join(','));
            }
            args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '128k', tmpOut);
            return args;
        };

        try {
            await ffmpeg.runCommand('ffmpeg', buildArgs(true));
        } catch (_) {
            await ffmpeg.runCommand('ffmpeg', buildArgs(false));
        }
        const mp3Buf = await fs.promises.readFile(tmpOut);
        return mp3Buf;
    } catch (_) {
        return inputBuffer;
    } finally {
        try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch (_) {}
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (_) {}
    }
}

function createAiInstance(apiKey) {
    const key = String(apiKey || '').trim();
    if (key.startsWith('AIza')) {
        return new GoogleGenAI({ apiKey: key });
    }
    return new GoogleGenAI({
        apiKey: key,
        vertexai: true,
        httpOptions: { baseUrl: 'https://aiplatform.googleapis.com/' },
    });
}

const STYLE_PROMPTS = {
    natural: '',
    calm: 'Say in a calm, warm, reverent tone: ',
    upbeat: 'Say in an upbeat, energetic, engaging tone: ',
    narrative: 'Say in a clear, steady, storytelling narrator tone: ',
    gentle: 'Say in a soft, gentle, comforting tone: ',
};

async function synthesizeGeminiVoice(text, voiceName, rate = '+0%', style = 'natural', customPromptPrefix = '') {
    const usableKeys = getUsableGeminiTtsKeys();
    if (!usableKeys.length) {
        throw new Error('当前选择的是 Google Gemini AI 拟真音色，请先在左侧「🔑 Gemini TTS API Key」或「设置」中填入免费的 Google AI Studio Gemini API Key，或将引擎切换为「🌐 免Key直连多音色 (Google Translate)」');
    }

    const persona = GEMINI_PERSONA_VOICES.find(p => p.id.toLowerCase() === String(voiceName).toLowerCase());
    const targetShortName = persona ? persona.baseVoice : voiceName;
    const validVoice = GEMINI_VOICES.some(v => v.ShortName.toLowerCase() === String(targetShortName).toLowerCase())
        ? GEMINI_VOICES.find(v => v.ShortName.toLowerCase() === String(targetShortName).toLowerCase()).ShortName
        : 'Kore';

    const stylePrefix = customPromptPrefix || (persona ? persona.prompt : '') || STYLE_PROMPTS[style] || '';
    const promptText = stylePrefix ? `${stylePrefix}${text}` : text;

    const startIndex = Math.floor(Math.random() * usableKeys.length);
    const orderedKeys = usableKeys.map((_, i) => usableKeys[(startIndex + i) % usableKeys.length]);
    const geminiData = settings.loadGeminiKeys?.() || {};
    const preferredModel = geminiData.tts_model === 'gemini-2.5-pro-preview-tts'
        ? ['gemini-2.5-pro-preview-tts', 'gemini-2.5-flash-preview-tts']
        : ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'];
    let lastErr = null;

    for (const modelId of preferredModel) {
        for (let attempt = 0; attempt < orderedKeys.length; attempt++) {
            const apiKey = orderedKeys[attempt];
            try {
                const ai = createAiInstance(apiKey);
                const response = await ai.models.generateContent({
                    model: modelId,
                    contents: [{ parts: [{ text: promptText }] }],
                    config: {
                        responseModalities: ['AUDIO'],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: validVoice,
                                },
                            },
                        },
                    },
                });

                const part = response?.candidates?.[0]?.content?.parts?.find(p => p?.inlineData?.data);
                if (!part?.inlineData?.data) {
                    throw new Error('Gemini TTS 未返回音频数据');
                }
                const rawBytes = Buffer.from(part.inlineData.data, 'base64');
                const mime = String(part.inlineData.mimeType || '').toLowerCase();
                let sampleRate = 24000;
                const rateMatch = mime.match(/rate=(\d+)/);
                if (rateMatch) sampleRate = parseInt(rateMatch[1], 10) || 24000;

                const isRawPcm = mime.includes('pcm') || mime.includes('l16') || (!mime.includes('mp3') && !mime.includes('wav') && !mime.includes('mpeg'));
                const wavOrMp3 = isRawPcm ? wrapPcm16ToWav(rawBytes, sampleRate, 1, 16) : rawBytes;
                const rawDurationSec = isRawPcm ? rawBytes.length / (sampleRate * 2) : 0;
                const ratePct = parseInt(String(rate || '+0%'), 10) || 0;
                const tempo = Math.max(0.5, Math.min(2.0, 1 + ratePct / 100));
                const effectiveDurationSec = rawDurationSec > 0 ? rawDurationSec / tempo : 0;

                const finalAudio = await convertToMp3WithSpeed(wavOrMp3, isRawPcm ? '.wav' : '.mp3', rate);
                return {
                    audio: finalAudio,
                    srt: buildSrtFromText(text, effectiveDurationSec),
                    usedKey: null,
                };
            } catch (err) {
                lastErr = err;
                const msg = err?.message || String(err);
                if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
                    break; // Try next modelId
                }
                continue;
            }
        }
    }
    const safeErrMsg = String(lastErr?.message || '请检查 Gemini API Key 或网络连接').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]');
    throw new Error(`Google Gemini 语音合成失败：${safeErrMsg}`);
}

function postJsonHttps(url, payload, timeoutMs = 20000, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': body.length,
                'User-Agent': USER_AGENT,
                ...extraHeaders,
            },
            timeout: timeoutMs,
        }, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(raw));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function synthesizeCloudVoice(text, cloudVoiceId, rate = '+0%', style = 'natural') {
    const cv = GOOGLE_CLOUD_VOICES.find(v => v.id === cloudVoiceId) || {
        id: cloudVoiceId,
        locale: cloudVoiceId.split('-').slice(0, 2).join('-') || 'en-US',
        fallbackGemini: 'Kore',
    };
    const usableKeys = getUsableGeminiTtsKeys();
    const ratePct = parseInt(String(rate || '+0%'), 10) || 0;
    const speakingRate = Math.max(0.5, Math.min(2.0, 1 + ratePct / 100));

    // 1. Try Google Cloud Text-to-Speech API first if keys are available
    for (const apiKey of usableKeys) {
        try {
            const langCode = cv.id.startsWith('cmn-') || cv.id.startsWith('yue-')
                ? cv.id.split('-').slice(0, 2).join('-')
                : cv.locale;
            const res = await postJsonHttps(
                'https://texttospeech.googleapis.com/v1/text:synthesize',
                {
                    input: { text },
                    voice: { languageCode: langCode, name: cv.id },
                    audioConfig: { audioEncoding: 'MP3', speakingRate },
                },
                18000,
                { 'X-Goog-Api-Key': apiKey }
            );
            if (res && res.audioContent) {
                const mp3Buf = Buffer.from(res.audioContent, 'base64');
                return {
                    audio: mp3Buf,
                    srt: buildSrtFromText(text, 0),
                    usedKey: null,
                };
            }
        } catch (_) {
            // Key might be an AI Studio Gemini Key without Cloud TTS billing enabled; fall through to Gemini 2.5 Native TTS
        }
    }

    // 2. Fallback to native Gemini 2.5 TTS with matching voice & regional accent prompt
    if (usableKeys.length > 0) {
        return await synthesizeGeminiVoice(text, cv.fallbackGemini || 'Kore', rate, style);
    }

    throw new Error('当前选择的是 Google Cloud / Gemini 拟真音色，请先在左侧「🔑 Gemini TTS API Key」或「设置」中填入免费的 Google AI Studio API Key');
}

async function testKeys(data = {}) {
    const rawKeys = Array.isArray(data.keys) && data.keys.length
        ? data.keys.map(k => String(k || '').trim()).filter(Boolean)
        : getUsableGeminiTtsKeys();
    if (!rawKeys.length) {
        throw new Error('请先输入至少一个 Gemini TTS API Key');
    }
    const modelId = data.model === 'gemini-2.5-pro-preview-tts'
        ? 'gemini-2.5-pro-preview-tts'
        : 'gemini-2.5-flash-preview-tts';
    const results = [];
    for (const key of rawKeys) {
        const masked = key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : '***';
        try {
            const ai = createAiInstance(key);
            const response = await ai.models.generateContent({
                model: modelId,
                contents: [{ parts: [{ text: 'Hello, Google Gemini voice studio is ready.' }] }],
                config: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: 'Kore' },
                        },
                    },
                },
            });
            const part = response?.candidates?.[0]?.content?.parts?.find(p => p?.inlineData?.data);
            if (!part?.inlineData?.data) {
                throw new Error('未返回音频流');
            }
            results.push({
                masked,
                valid: true,
                model: modelId,
                message: `✅ 语音合成测试通过 (${modelId})`,
            });
        } catch (err) {
            const safeMsg = String(err?.message || err).replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]').slice(0, 140);
            results.push({
                masked,
                valid: false,
                model: modelId,
                message: `❌ 失败: ${safeMsg}`,
            });
        }
    }
    return { results };
}

async function synthesizeGoogleTranslateVoice(text, voiceSpec = 'en-US', rate = '+0%', style = 'natural') {
    const [rawLocale, rawPresetKey] = String(voiceSpec || 'en-US').split(':');
    const locale = rawLocale || 'en-US';
    const presetKey = rawPresetKey || 'default';
    const entry = GOOGLE_TRANSLATE_VOICES.find(v => v.locale === locale) || { locale, tl: locale };
    const preset = GOOGLE_TRANSLATE_VOICE_PRESETS.find(p => p.key === presetKey) || GOOGLE_TRANSLATE_VOICE_PRESETS[0];
    const tl = entry.tl || locale || 'en-US';
    const chunks = splitTextIntoChunks(text, 180);
    if (!chunks.length) throw new Error('配音文案不能为空');

    const buffers = [];
    for (const chunk of chunks) {
        let buf = null;
        const urls = [
            `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${encodeURIComponent(tl)}&ttsspeed=1&client=tw-ob`,
            `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${encodeURIComponent(tl)}&ttsspeed=1&client=gtx`,
        ];
        let lastErr = null;
        for (const url of urls) {
            try {
                buf = await fetchHttpsBuffer(url, 20000);
                if (buf && buf.length > 0) break;
            } catch (e) {
                lastErr = e;
            }
        }
        if (!buf || !buf.length) {
            throw new Error(`连接 Google 免费语音服务失败：${lastErr?.message || '未返回音频'}`);
        }
        buffers.push(buf);
    }

    let combined = Buffer.concat(buffers);
    combined = await convertToMp3WithSpeed(combined, '.mp3', rate, preset, style);
    return {
        audio: combined,
        srt: buildSrtFromText(text, 0),
        usedKey: null,
    };
}

async function synthesize(text, voice, rate = '+0%', style = 'natural') {
    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('配音文案不能为空');
    const rawVoice = String(voice || 'gtrans:en-US').trim();

    if (rawVoice.startsWith('gemini:')) {
        const voiceName = rawVoice.slice('gemini:'.length);
        return await synthesizeGeminiVoice(cleanText, voiceName, rate, style);
    }
    if (rawVoice.startsWith('cloud:')) {
        const cloudId = rawVoice.slice('cloud:'.length);
        return await synthesizeCloudVoice(cleanText, cloudId, rate, style);
    }
    const voiceSpec = rawVoice.startsWith('gtrans:') ? rawVoice.slice('gtrans:'.length) : rawVoice;
    return await synthesizeGoogleTranslateVoice(cleanText, voiceSpec, rate, style);
}

async function preview(data = {}) {
    const text = String(data.text || '').trim();
    if (!text) throw new Error('试听文案不能为空');
    const res = await synthesize(text, data.voice, data.rate || '+0%', data.style || 'natural');
    return {
        audio_base64: res.audio.toString('base64'),
        srt: res.srt || '',
    };
}

async function saveItem(data = {}) {
    const text = String(data.text || '').trim();
    if (!text) throw new Error('配音文案不能为空');
    const folder = edgeTts.resolveTaskFolder(data.baseFolder, data.taskName);
    await fs.promises.mkdir(folder, { recursive: true });

    const cleanedFile = path.basename(String(data.fileName || 'voice.mp3').trim())
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/[. ]+$/g, '')
        .slice(0, 140) || 'voice.mp3';
    const baseName = path.parse(cleanedFile).name || 'voice';
    const mp3Name = `${baseName}.mp3`;
    const mp4Name = `${baseName}.mp4`;
    const srtName = `${baseName}.srt`;

    const res = await synthesize(text, data.voice, data.rate || '+0%', data.style || 'natural');
    const mp3Path = path.join(folder, mp3Name);
    const mp4Path = path.join(folder, mp4Name);
    const srtPath = path.join(folder, srtName);

    await fs.promises.writeFile(mp3Path, res.audio);
    if (res.srt) {
        await fs.promises.writeFile(srtPath, res.srt, 'utf8');
    }

    try {
        const ffmpeg = require('./ffmpeg');
        await ffmpeg.runCommand('ffmpeg', [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', mp3Path,
            '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
            mp4Path,
        ]);
    } catch (_) {
        await fs.promises.copyFile(mp3Path, mp4Path);
    }

    return {
        folder,
        fileName: mp3Name,
        baseName,
        paths: {
            mp3: mp3Path,
            mp4: mp4Path,
            srt: res.srt ? srtPath : '',
        },
        audio_base64: res.audio.toString('base64'),
        srt: res.srt || '',
    };
}

async function createZip(data = {}) {
    return await edgeTts.createZip(data);
}

module.exports = {
    GEMINI_VOICES,
    GEMINI_PERSONA_VOICES,
    GOOGLE_CLOUD_VOICES,
    GOOGLE_TRANSLATE_VOICES,
    GOOGLE_TRANSLATE_VOICE_PRESETS,
    wrapPcm16ToWav,
    listVoices,
    testKeys,
    synthesize,
    preview,
    saveItem,
    createZip,
};
