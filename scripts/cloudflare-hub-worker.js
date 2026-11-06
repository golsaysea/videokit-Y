/**
 * VideoKit ☁️ 云端中控台 & 每日工程分发中心 (Cloudflare Worker 单文件完整版)
 *
 * 使用方法：
 * 1. 登录 https://dash.cloudflare.com -> Workers & Pages -> 创建 Worker
 * 2. 将本文件代码完整复制粘贴到 Worker 编辑器中，点击「部署 (Deploy)」
 * 3. (强烈推荐) 绑定 KV 命名空间以永久保存网页端修改：
 *    - 在 Cloudflare 左侧菜单进入 KV -> Create a namespace，名称填：VIDEOKIT_HUB
 *    - 进入你的 Worker -> Settings -> Bindings -> Add binding -> KV Namespace
 *    - Variable name 填：HUB_KV ，选择刚才创建的命名空间并保存。
 * 4. (可选) 设置访问密码：
 *    - 在 Worker -> Settings -> Variables and Secrets 中添加环境变量：HUB_TOKEN = 你的密码
 * 5. 把 Worker 的网址（如 https://videokit-hub.你的名字.workers.dev）填进 VideoKit 软件的「☁️ 云端中控 · 日期贴」即可！
 *    直接用浏览器打开该网址，即可进入可视化管理后台（添加 API Key、发布每日 Google Drive 工程链接）。
 */

const DEFAULT_HUB_DATA = {
  version: 1,
  updated_at: new Date().toISOString(),
  primary_transcription: 'groq',
  groq_keys: [],
  gladia_keys: [],
  deepgram_keys: [],
  gemini_keys: [],
  gemini_tts_keys: [],
  gemini_model: 'gemini-3.5-flash-lite',
  elevenlabs_keys: [],
  daily_projects: [
    // 示例格式：
    // {
    //   date: '2026-11-06',
    //   title: '11月6日 主日祷告批量工程 (20条)',
    //   url: 'https://drive.google.com/file/d/你的谷歌网盘文件ID/view?usp=sharing',
    //   note: '素材文件夹：1106_素材包'
    // }
  ]
};

const KV_KEY = 'videokit_hub_config_v1';

function checkAuth(request, env) {
  const requiredToken = String(env?.HUB_TOKEN || '').trim();
  if (!requiredToken) return true;
  const url = new URL(request.url);
  const queryToken = (url.searchParams.get('token') || '').trim();
  const headerToken = (request.headers.get('x-hub-token') || '').trim();
  const authHeader = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return queryToken === requiredToken || headerToken === requiredToken || authHeader === requiredToken;
}

async function loadData(env) {
  if (env?.HUB_KV) {
    try {
      const raw = await env.HUB_KV.get(KV_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_HUB_DATA, ...parsed };
      }
    } catch (_) {}
  }
  return { ...DEFAULT_HUB_DATA };
}

async function saveData(env, data) {
  const next = {
    ...DEFAULT_HUB_DATA,
    ...data,
    updated_at: new Date().toISOString(),
  };
  if (env?.HUB_KV) {
    await env.HUB_KV.put(KV_KEY, JSON.stringify(next, null, 2));
  }
  return next;
}

function normalizeKeyList(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map(k => String(k || '').trim()).filter(Boolean))];
  }
  if (typeof input === 'string') {
    return [...new Set(input.split(/[\r\n,]+/).map(k => k.trim()).filter(Boolean))];
  }
  return [];
}

function renderAdminHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VideoKit ☁️ 云端中控台 & 每日工程分发中心</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#0f172a; color:#e2e8f0; padding:24px; }
  .wrap { max-width:980px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }
  .card { background:#1e293b; border:1px solid #334155; border-radius:12px; padding:18px 20px; box-shadow:0 8px 24px rgba(0,0,0,0.25); }
  h1 { margin:0 0 6px 0; font-size:22px; color:#38bdf8; }
  h2 { margin:0 0 12px 0; font-size:16px; color:#fde047; }
  label { display:block; font-size:12.5px; color:#94a3b8; margin-bottom:4px; font-weight:600; }
  textarea, input, select { width:100%; box-sizing:border-box; background:#0f172a; border:1px solid #475569; color:#f8fafc; border-radius:8px; padding:8px 10px; font-size:13px; font-family:monospace; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .btn { background:linear-gradient(135deg,#0284c7,#2563eb); color:#fff; border:1px solid #7dd3fc; border-radius:8px; padding:9px 16px; font-size:13.5px; font-weight:700; cursor:pointer; }
  .btn-green { background:linear-gradient(135deg,#059669,#10b981); border-color:#6ee7b7; }
  .btn-red { background:rgba(239,68,68,0.2); border:1px solid rgba(248,113,113,0.5); color:#fca5a5; padding:4px 10px; font-size:12px; }
  .proj-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; background:#0f172a; border:1px solid #334155; border-radius:8px; margin-bottom:8px; }
  .status { font-size:13px; color:#6ee7b7; font-weight:600; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>☁️ VideoKit 云端中控台 & 每日工程分发中心</h1>
    <div style="font-size:13px;color:#94a3b8;">将当前网页地址填进 VideoKit 客户端「☁️ 云端中控 · 日期贴」，即可一键同步全部 API Key 池并拉取每日 Google Drive 工程。</div>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center;">
      <input id="token" type="password" placeholder="访问密码 HUB_TOKEN (如未设置可留空)" style="max-width:300px;">
      <button class="btn" onclick="loadConfig()">🔄 读取当前配置</button>
      <button class="btn btn-green" onclick="saveConfig()">💾 保存全部修改到云端</button>
      <span id="status" class="status"></span>
    </div>
  </div>

  <div class="card">
    <h2>📅 1. 每日工程（Google Drive 日期贴）</h2>
    <div style="display:grid;grid-template-columns:140px 1fr 1.4fr 1fr auto;gap:8px;margin-bottom:12px;align-items:end;">
      <div><label>日期</label><input id="new-date" type="date"></div>
      <div><label>工程标题</label><input id="new-title" placeholder="例如：今日主日祷告20条"></div>
      <div><label>Google Drive 分享链接 / 直链</label><input id="new-url" placeholder="https://drive.google.com/file/d/.../view"></div>
      <div><label>备注(可选)</label><input id="new-note" placeholder="素材包说明"></div>
      <button class="btn btn-green" onclick="addProject()">➕ 添加日期贴</button>
    </div>
    <div id="proj-list"></div>
  </div>

  <div class="card">
    <h2>🔑 2. 远程 API Key 池配置（一行一个 Key，客户端自动并发轮询）</h2>
    <div style="margin-bottom:12px;max-width:260px;">
      <label>默认首选转录引擎</label>
      <select id="primary_transcription">
        <option value="groq">Groq (极速推荐)</option>
        <option value="gladia">Gladia</option>
        <option value="deepgram">Deepgram</option>
      </select>
    </div>
    <div class="grid2">
      <div><label>Groq Keys (一行一个)</label><textarea id="groq_keys" rows="5"></textarea></div>
      <div><label>Gladia Keys (一行一个)</label><textarea id="gladia_keys" rows="5"></textarea></div>
      <div><label>Deepgram Keys (一行一个)</label><textarea id="deepgram_keys" rows="4"></textarea></div>
      <div><label>Gemini Keys (AI文案/命名/TTS，一行一个)</label><textarea id="gemini_keys" rows="4"></textarea></div>
      <div style="grid-column:1 / -1;"><label>ElevenLabs Keys (配音 Key 池，一行一个)</label><textarea id="elevenlabs_keys" rows="4"></textarea></div>
    </div>
  </div>
</div>
<script>
let state = { daily_projects: [] };
document.getElementById('new-date').value = new Date().toISOString().slice(0, 10);

function getHeaders() {
  const t = document.getElementById('token').value.trim();
  return t ? { 'Content-Type': 'application/json', 'X-Hub-Token': t } : { 'Content-Type': 'application/json' };
}

function renderProjects() {
  const box = document.getElementById('proj-list');
  const list = Array.isArray(state.daily_projects) ? state.daily_projects : [];
  if (!list.length) {
    box.innerHTML = '<div style="color:#64748b;font-size:13px;">暂无每日工程，请在上方添加 Google Drive 分享链接。</div>';
    return;
  }
  box.innerHTML = list.map((p, idx) => \`
    <div class="proj-row">
      <div style="min-width:0;flex:1;">
        <div style="font-weight:700;color:#fde047;">📅 \${p.date || ''} — <span style="color:#f8fafc;">\${p.title || '未命名工程'}</span></div>
        <div style="font-size:12px;color:#38bdf8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🔗 \${p.url || ''}</div>
        \${p.note ? \`<div style="font-size:11.5px;color:#94a3b8;">📝 \${p.note}</div>\` : ''}
      </div>
      <button class="btn btn-red" onclick="removeProject(\${idx})">删除</button>
    </div>
  \`).join('');
}

function addProject() {
  const date = document.getElementById('new-date').value.trim() || new Date().toISOString().slice(0, 10);
  const title = document.getElementById('new-title').value.trim() || (date + ' 批量工程');
  const url = document.getElementById('new-url').value.trim();
  const note = document.getElementById('new-note').value.trim();
  if (!url) { alert('请填写 Google Drive 工程链接'); return; }
  state.daily_projects = [{ date, title, url, note, updated_at: new Date().toISOString() }, ...(state.daily_projects || [])];
  document.getElementById('new-title').value = '';
  document.getElementById('new-url').value = '';
  document.getElementById('new-note').value = '';
  renderProjects();
  saveConfig();
}

function removeProject(idx) {
  state.daily_projects.splice(idx, 1);
  renderProjects();
}

async function loadConfig() {
  const st = document.getElementById('status');
  st.textContent = '读取中...';
  try {
    const res = await fetch('?format=json', { headers: getHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '读取失败');
    state = data;
    document.getElementById('primary_transcription').value = data.primary_transcription || 'groq';
    ['groq_keys','gladia_keys','deepgram_keys','gemini_keys','elevenlabs_keys'].forEach(k => {
      document.getElementById(k).value = (data[k] || []).join('\\n');
    });
    renderProjects();
    st.textContent = '✅ 已同步最新云端数据';
  } catch (e) {
    st.textContent = '❌ ' + e.message;
  }
}

async function saveConfig() {
  const st = document.getElementById('status');
  st.textContent = '保存中...';
  try {
    const payload = {
      ...state,
      primary_transcription: document.getElementById('primary_transcription').value,
    };
    ['groq_keys','gladia_keys','deepgram_keys','gemini_keys','elevenlabs_keys'].forEach(k => {
      payload[k] = document.getElementById(k).value.split(/\\r?\\n/).map(s => s.trim()).filter(Boolean);
    });
    const res = await fetch('', { method: 'POST', headers: getHeaders(), body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存失败');
    state = data.data || payload;
    renderProjects();
    st.textContent = '✅ 保存成功 (' + new Date().toLocaleTimeString() + ')';
  } catch (e) {
    st.textContent = '❌ ' + e.message;
  }
}

loadConfig();
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Hub-Token',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const accept = request.headers.get('accept') || '';
    const wantsJson = url.searchParams.get('format') === 'json'
      || url.pathname.endsWith('/json')
      || url.pathname.endsWith('/api')
      || (!accept.includes('text/html') && request.method === 'GET');

    if (request.method === 'GET' && !wantsJson) {
      return new Response(renderAdminHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }

    if (!checkAuth(request, env)) {
      return new Response(JSON.stringify({ ok: false, error: '访问密钥 (HUB_TOKEN) 不正确或未提供' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    if (request.method === 'GET') {
      const data = await loadData(env);
      return new Response(JSON.stringify({ ok: true, ...data }, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    if (request.method === 'POST' || request.method === 'PUT') {
      try {
        const body = await request.json();
        const current = await loadData(env);

        if (body.action === 'add_daily_project' && body.project) {
          const proj = {
            id: body.project.id || ('dp_' + Date.now().toString(36)),
            date: String(body.project.date || new Date().toISOString().slice(0, 10)).trim(),
            title: String(body.project.title || '每日云端工程').trim(),
            url: String(body.project.url || '').trim(),
            note: String(body.project.note || '').trim(),
            updated_at: new Date().toISOString(),
          };
          const list = Array.isArray(current.daily_projects) ? current.daily_projects : [];
          current.daily_projects = [proj, ...list.filter(item => !(item.date === proj.date && item.title === proj.title && item.url === proj.url))];
          const saved = await saveData(env, current);
          return new Response(JSON.stringify({ ok: true, data: saved }), {
            headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
          });
        }

        if (body.action === 'delete_daily_project') {
          const list = Array.isArray(current.daily_projects) ? current.daily_projects : [];
          current.daily_projects = list.filter((item, idx) => {
            if (body.id && item.id === body.id) return false;
            if (typeof body.index === 'number' && idx === body.index) return false;
            if (body.url && item.url === body.url && (!body.date || item.date === body.date)) return false;
            return true;
          });
          const saved = await saveData(env, current);
          return new Response(JSON.stringify({ ok: true, data: saved }), {
            headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
          });
        }

        const next = {
          ...current,
          primary_transcription: body.primary_transcription || body.primary || current.primary_transcription || 'groq',
          groq_keys: body.groq_keys !== undefined ? normalizeKeyList(body.groq_keys) : current.groq_keys,
          gladia_keys: body.gladia_keys !== undefined ? normalizeKeyList(body.gladia_keys) : current.gladia_keys,
          deepgram_keys: body.deepgram_keys !== undefined ? normalizeKeyList(body.deepgram_keys) : current.deepgram_keys,
          gemini_keys: body.gemini_keys !== undefined ? normalizeKeyList(body.gemini_keys) : current.gemini_keys,
          gemini_tts_keys: body.gemini_tts_keys !== undefined ? normalizeKeyList(body.gemini_tts_keys) : current.gemini_tts_keys,
          gemini_model: body.gemini_model || current.gemini_model || 'gemini-3.5-flash-lite',
          elevenlabs_keys: body.elevenlabs_keys !== undefined ? normalizeKeyList(body.elevenlabs_keys) : current.elevenlabs_keys,
          daily_projects: Array.isArray(body.daily_projects) ? body.daily_projects : current.daily_projects,
        };
        const saved = await saveData(env, next);
        return new Response(JSON.stringify({ ok: true, data: saved }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err?.message || '请求格式错误' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
        });
      }
    }

    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
    });
  }
};
