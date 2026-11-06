/**
 * 暖屿 · 情感陪伴 AI —— 后端代理 + 简易后台
 *
 * 特性：
 *  - 多 Provider：豆包/智谱/DeepSeek/通义/硅基流动/Kimi/Gemini/本地 Ollama（均可切换）
 *  - 服务端预置默认 Key 兜底：用户不填 Key 时自动使用站点默认额度（Plan A）
 *  - 用量统计：仅统计“服务端默认 Key”的消耗（用户自带 Key 不计入，保护隐私）
 *  - 简易后台 /admin.html：登录、填默认 Key、看用量、改密码
 *
 * 部署：宝塔里新建站点 → 反向代理到 http://127.0.0.1:3000，端口用 PORT 环境变量改。
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- 持久化：设置 & 用量 ----------------
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const PEPPER = process.env.ADMIN_PEPPER || 'warmisle-pepper-v1';

const loadJson = (file, def) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
};
let settings = loadJson(SETTINGS_FILE, { defaultKeys: {}, adminPasswordHash: '' });
if (!settings.defaultKeys) settings.defaultKeys = {};
let usage = loadJson(USAGE_FILE, {});

let settingsTimer = null, usageTimer = null;
const saveSettingsSoon = () => {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)), 300);
};
const saveSettingsNow = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
const saveUsageSoon = () => {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(() => fs.writeFileSync(USAGE_FILE, JSON.stringify(usage), null, 2), 1000);
};

// ---------------- Provider 定义（前端下拉的唯一真相来源）----------------
const PROVIDERS = [
  { id: 'doubao', name: '豆包（字节/火山·免费）', needKey: true, openai: true,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    models: ['doubao-seed-mini-250615', 'doubao-seed-1-6-250615', 'doubao-lite-32k', 'doubao-pro-32k'],
    hint: '火山引擎 Ark 控制台创建应用拿 Key；seed-mini 每日 200 万 token 免费。' },
  { id: 'zhipu', name: '智谱 GLM（免费）', needKey: true, openai: true,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-airx'],
    hint: 'bigmodel.cn 注册；glm-4-flash 永久免费 500 万 token/月。' },
  { id: 'deepseek', name: 'DeepSeek（极便宜）', needKey: true, openai: true,
    baseUrl: 'https://api.deepseek.com/chat/completions',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hint: 'platform.deepseek.com；新用户 500 万免费，输入仅 ¥0.18/百万。' },
  { id: 'qwen', name: '通义千问（免费）', needKey: true, openai: true,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen3.5-plus'],
    hint: '阿里云百炼；新用户 7000 万 token 免费。' },
  { id: 'siliconflow', name: '硅基流动（9B 以下永久免费）', needKey: true, openai: true,
    baseUrl: 'https://api.siliconflow.cn/v1/chat/completions',
    models: ['Qwen/Qwen3-8B', 'deepseek-ai/DeepSeek-V3', 'THUDM/glm-4-9b-chat', 'moonshotai/Kimi-K2-Instruct'],
    hint: 'siliconflow.cn；9B 以下模型永久免费，国内延迟低。' },
  { id: 'moonshot', name: 'Kimi（月之暗面）', needKey: true, openai: true,
    baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    hint: 'platform.moonshot.cn；免费每分钟 3 次。' },
  { id: 'gemini', name: 'Gemini（Google）', needKey: true, openai: false,
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'],
    hint: 'aistudio.google.com/apikey；免费层 15 RPM / 1500 RPD。' },
  { id: 'ollama', name: '本地 Ollama（离线·隐私）', needKey: false, openai: false,
    models: ['qwen3:4b', 'gemma3-uncensored:latest', 'qwen2.5:7b', 'llama3.1:8b'],
    hint: '本机需 ollama serve 并拉取模型，无需 Key。' },
];

const PROVIDER_MAP = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
const ENV_KEY = {
  doubao: 'DOUBAO_API_KEY', zhipu: 'ZHIPU_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY', siliconflow: 'SILICONFLOW_API_KEY', moonshot: 'MOONSHOT_API_KEY',
  gemini: 'GEMINI_API_KEY',
};
const defaultKeyFor = (id) =>
  (settings.defaultKeys[id] || process.env[ENV_KEY[id]] || '').trim();

// ---------------- 管理员鉴权 ----------------
const hashPwd = (p) => crypto.createHash('sha256').update(p + PEPPER).digest('hex');
const sessions = new Map(); // token -> expireAt

function ensureAdmin() {
  if (process.env.ADMIN_PASSWORD) {
    settings.adminPasswordHash = hashPwd(process.env.ADMIN_PASSWORD);
    saveSettingsNow();
    return;
  }
  if (!settings.adminPasswordHash) {
    const pw = crypto.randomBytes(6).toString('hex'); // 12 位十六进制
    settings.adminPasswordHash = hashPwd(pw);
    saveSettingsNow();
    console.log('\n========================================================');
    console.log(' 首次运行 · 管理员初始密码： ' + pw);
    console.log(' 请打开 /admin.html 登录后尽快修改。');
    console.log(' （也可用环境变量 ADMIN_PASSWORD 预设）');
    console.log('========================================================\n');
  }
}
ensureAdmin();

const requireAdmin = (req, res, next) => {
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const exp = sessions.get(tok);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: '未登录或登录已过期' });
  next();
};

// ---------------- 用量统计 ----------------
function recordUsage(provider, promptTokens, completionTokens) {
  if (!provider) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!usage[provider]) usage[provider] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, days: {} };
  const u = usage[provider];
  u.requests += 1;
  u.promptTokens += promptTokens || 0;
  u.completionTokens += completionTokens || 0;
  u.totalTokens += (promptTokens || 0) + (completionTokens || 0);
  if (!u.days[today]) u.days[today] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  u.days[today].requests += 1;
  u.days[today].promptTokens += promptTokens || 0;
  u.days[today].completionTokens += completionTokens || 0;
  u.days[today].totalTokens += (promptTokens || 0) + (completionTokens || 0);
  saveUsageSoon();
}

// ---------------- SSE 工具 ----------------
const sendEvent = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

// 估算 token（无 usage 时兜底）：用字符数 /4 偏保守
const estTokens = (text) => Math.max(1, Math.round((text || '').length / 4));

// Ollama：NDJSON 流
async function streamOllama({ model, messages, temperature }, res) {
  const r = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { temperature } }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Ollama 返回 ${r.status}：${t || r.statusText}（确认 Ollama 已启动且已拉取模型 ${model}）`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let outChars = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j.message && j.message.content) { sendEvent(res, { delta: j.message.content }); outChars += j.message.content.length; }
      } catch (_) {}
    }
  }
  return { promptTokens: estTokens(messages.map((m) => m.content).join('')), completionTokens: estTokens(outChars) };
}

// OpenAI 兼容（豆包/智谱/DeepSeek/通义/硅基流动/Kimi）
async function streamOpenAI({ baseUrl, apiKey, model, messages, temperature }, res) {
  const r = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: true, temperature, stream_options: { include_usage: true } }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`API 返回 ${r.status}：${t || r.statusText}（检查 Key 与模型名）`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let outChars = 0;
  let realUsage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (d) { sendEvent(res, { delta: d }); outChars += d.length; }
        if (j.usage) realUsage = j.usage;
      } catch (_) {}
    }
  }
  const promptTokens = realUsage ? (realUsage.prompt_tokens || estTokens(messages.map((m) => m.content).join('')))
    : estTokens(messages.map((m) => m.content).join(''));
  const completionTokens = realUsage ? (realUsage.completion_tokens || estTokens(outChars)) : estTokens(outChars);
  return { promptTokens, completionTokens };
}

// Gemini：SSE（alt=sse）
async function streamGemini({ apiKey, model, messages, temperature }, res) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const systemText = (messages.find((m) => m.role === 'system') || {}).content || '';
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents, generationConfig: { temperature } };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Gemini 返回 ${r.status}：${t || r.statusText}（检查 Key 与模型名）`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let outChars = 0;
  let meta = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        const j = JSON.parse(data);
        if (j.usageMetadata) meta = j.usageMetadata;
        const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
        if (parts) for (const p of parts) if (p.text) { sendEvent(res, { delta: p.text }); outChars += p.text.length; }
      } catch (_) {}
    }
  }
  const promptTokens = meta ? (meta.promptTokenCount || estTokens(messages.map((m) => m.content).join(''))) : estTokens(messages.map((m) => m.content).join(''));
  const completionTokens = meta ? (meta.candidatesTokenCount || estTokens(outChars)) : estTokens(outChars);
  return { promptTokens, completionTokens };
}

// ---------------- 接口 ----------------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/models', (req, res) => {
  const providers = PROVIDERS.map((p) => ({ ...p, hasDefault: p.needKey ? !!defaultKeyFor(p.id) : true }));
  res.json({ providers });
});

app.post('/api/chat', async (req, res) => {
  const { provider, model, apiKey, messages, temperature = 0.85 } = req.body || {};
  if (!provider || !model || !Array.isArray(messages)) {
    return res.status(400).json({ error: '参数缺失：provider / model / messages' });
  }
  const p = PROVIDER_MAP[provider];
  if (!p) return res.status(400).json({ error: '未知的 provider：' + provider });

  const userKey = (apiKey || '').trim();
  const effectiveKey = userKey || defaultKeyFor(provider);
  if (p.needKey && !effectiveKey) {
    return res.status(400).json({ error: '该服务商暂未配置默认 Key，请在左侧填入你自己的 API Key。' });
  }
  const useServerKey = p.needKey && !userKey && !!effectiveKey; // 仅统计站点默认 Key 的用量

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  try {
    let counts = { promptTokens: 0, completionTokens: 0 };
    if (provider === 'ollama') {
      counts = await streamOllama({ model, messages, temperature }, res);
    } else if (p.openai) {
      counts = await streamOpenAI({ baseUrl: p.baseUrl, apiKey: effectiveKey, model, messages, temperature }, res);
    } else if (provider === 'gemini') {
      counts = await streamGemini({ apiKey: effectiveKey, model, messages, temperature }, res);
    } else {
      throw new Error('配置错误：provider 无法路由');
    }
    if (useServerKey) recordUsage(provider, counts.promptTokens, counts.completionTokens);
    sendEvent(res, { done: true });
  } catch (e) {
    sendEvent(res, { error: e.message || String(e) });
  } finally {
    res.end();
  }
});

// ---------------- 后台接口 ----------------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || hashPwd(password) !== settings.adminPasswordHash) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + 2 * 3600 * 1000); // 2 小时
  res.json({ token });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const providers = PROVIDERS.filter((p) => p.needKey).map((p) => {
    const k = defaultKeyFor(p.id);
    return { id: p.id, name: p.name, hasKey: !!k, masked: k ? k.slice(0, 4) + '****' + k.slice(-4) : '' };
  });
  res.json({ providers });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { keys, adminPassword } = req.body || {};
  if (keys && typeof keys === 'object') {
    for (const id of Object.keys(keys)) {
      const v = (keys[id] || '').trim();
      if (PROVIDER_MAP[id] && PROVIDER_MAP[id].needKey) {
        if (v) settings.defaultKeys[id] = v;
        else delete settings.defaultKeys[id];
      }
    }
  }
  if (adminPassword && String(adminPassword).length >= 6) {
    settings.adminPasswordHash = hashPwd(adminPassword);
  }
  saveSettingsNow();
  res.json({ ok: true });
});

app.get('/api/admin/usage', requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = PROVIDERS.map((p) => {
    const u = usage[p.id] || { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const d = (u.days && u.days[today]) || { requests: 0, totalTokens: 0 };
    return {
      id: p.id, name: p.name, hasDefault: p.needKey ? !!defaultKeyFor(p.id) : true,
      totalRequests: u.requests, totalTokens: u.totalTokens,
      todayRequests: d.requests, todayTokens: d.totalTokens,
    };
  });
  res.json({ today, rows });
});

app.listen(PORT, () => {
  console.log(`暖屿 · 情感陪伴 AI 已启动： http://localhost:${PORT}  （后台：/admin.html）`);
});
