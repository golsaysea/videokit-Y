/**
 * VideoKit ☁️ 极简云端中控模板（免建 KV！只需修改下面 Key 和 1 个谷歌链接，点击 Deploy 即可）
 *
 * 使用步骤：
 * 1. 登录 https://dash.cloudflare.com -> Workers & Pages -> 创建 Worker
 * 2. 将本代码完整粘贴进去，修改下方 API Key 和 1 个 Google Drive 分享链接，点击「Deploy（部署）」
 *    （无需新建 KV 命名空间、无需绑定任何变量！）
 * 3. 把生成好的 Worker 网址（如 https://videokit-hub.你的名字.workers.dev）填进 VideoKit 的「☁️ 云端中控 · 日期贴」即可
 */

const HUB_CONFIG = {
  // 默认首选识别引擎: 'groq' | 'gladia' | 'deepgram'
  primary_transcription: 'groq',

  // ① 上面配置各类 API Key（英文单引号括起来，多个用英文逗号隔开）
  groq_keys: [
    // 'gsk_你的GroqKey1',
    // 'gsk_你的GroqKey2',
  ],
  gladia_keys: [
    // '你的GladiaKey',
  ],
  deepgram_keys: [
    // '你的DeepgramKey',
  ],
  gemini_keys: [
    // 'AIzaSy你的GeminiKey',
  ],
  gemini_tts_keys: [
    // 可选；留空则自动共用上面的 gemini_keys
  ],
  elevenlabs_keys: [
    // 'sk_你的ElevenLabsKey',
  ],

  // ② 下面只填这 1 个谷歌链接！（请在 Google Drive 设为「知道链接的任何人可查看」）
  // 支持任意一种方式：
  //   • Google Drive「文件夹」链接：把每天可编辑的 .json / .reels-project.json 工程丢进该文件夹，软件自动全部列出
  //   • 单个「工程 .json」分享链接：软件直接下载并加载该可编辑工程
  //   • 谷歌文档链接：文档正文写每日工程链接或工程 JSON
  google_drive_url: 'https://drive.google.com/drive/folders/这里替换成你的谷歌共享文件夹链接',
};

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Hub-Token',
      'Cache-Control': 'no-store',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 可选访问密码：只有在 Cloudflare 环境变量里主动设置了 HUB_TOKEN 时才会校验，默认无需任何设置
    const requiredToken = String(env?.HUB_TOKEN || '').trim();
    if (requiredToken) {
      const url = new URL(request.url);
      const qToken = (url.searchParams.get('token') || '').trim();
      const hToken = (request.headers.get('x-hub-token') || '').trim();
      const aToken = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (qToken !== requiredToken && hToken !== requiredToken && aToken !== requiredToken) {
        return new Response(JSON.stringify({ ok: false, error: '访问密钥 (HUB_TOKEN) 不正确或未提供' }), {
          status: 401,
          headers: corsHeaders,
        });
      }
    }

    return new Response(JSON.stringify(HUB_CONFIG, null, 2), { headers: corsHeaders });
  },
};
