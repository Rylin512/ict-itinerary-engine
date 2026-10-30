/* AI 通道层：OpenAI 兼容接口的统一客户端（DeepSeek / OpenRouter / SiliconFlow / 华为云 MaaS / 离线演示）
 *
 * 设计约束（对应 方案蓝图 / 技术设计文档）：
 *  - LLM 只做"表达"，输入必须带上结构化事实（行程 JSON / 攻略库条目），提示词里禁止编造；
 *  - key 只存 localStorage 或本地 serve.py 环境变量，不写进任何提交的代码；
 *  - DeepSeek 官方接口不允许浏览器直连（无 CORS），必须经 serve.py /api/llm 转发；
 *    OpenRouter / SiliconFlow 支持浏览器直连，纯双击打开 travel.html 也能用。
 */
'use strict';

const AI_PROVIDERS = {
  openrouter: {
    label: 'OpenRouter（有免费 DeepSeek 模型，浏览器直连）',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-r1:free',
    hint: '免费账户每天约 50 次请求，openrouter.ai 注册建 key 即可，无需绑卡；模型列表以官网为准',
  },
  deepseek: {
    label: 'DeepSeek 官方（需本地 serve.py 代理）',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '官方接口不支持浏览器直连，本页自动经本地 serve.py /api/llm 转发；key 也可配在 serve.py 环境变量 DEEPSEEK_API_KEY',
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow（浏览器直连）',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    hint: '国内可直连，部分模型有免费额度',
  },
  huaweimaas: {
    label: '华为云 MaaS（大赛推荐渠道）',
    baseURL: 'https://api.modelarts-maas.com/v1',
    model: 'DeepSeek-V3',
    hint: '按 token 计费，大赛代金券可覆盖；baseURL 与模型名以你的 ModelArts Studio 控制台为准',
  },
  demo: {
    label: '离线演示（不联网，返回预置演示文案）',
    baseURL: '',
    model: 'demo',
    hint: '答辩断网兜底：讲解/问答基于本页真实数据生成，明确标注"离线演示"',
  },
};

const AI_LS_KEY = 'travel.ai.config';

const AI = {
  cfg: { provider: 'demo', baseURL: '', model: '', key: '' },
  server: null, // serve.py 探测结果：{proxy, channels:[...], fallbackReady} | null

  load() {
    try {
      const raw = localStorage.getItem(AI_LS_KEY);
      if (raw) Object.assign(this.cfg, JSON.parse(raw));
    } catch (e) { /* 损坏的配置直接用默认 */ }
  },
  save() {
    localStorage.setItem(AI_LS_KEY, JSON.stringify(this.cfg));
  },
  clear() {
    localStorage.removeItem(AI_LS_KEY);
    this.cfg = { provider: 'demo', baseURL: '', model: '', key: '' };
  },

  async probeServer() {
    if (!location.protocol.startsWith('http')) { this.server = null; return this.server; }
    try {
      const r = await fetch('/api/ai-config', { cache: 'no-store' });
      this.server = r.ok ? await r.json() : null;
    } catch (e) { this.server = null; }
    return this.server;
  },

  envKeyReady(baseURL) {
    if (!this.server || !this.server.channels) return false;
    if (this.server.fallbackReady) return true;
    const host = (baseURL || '').toLowerCase();
    return this.server.channels.some(c => c.ready && host.includes(c.id));
  },

  // 通道是否可用（demo 恒可用；其余要求 key 或本地环境变量）
  ready() {
    if (this.cfg.provider === 'demo') return true;
    return !!(this.cfg.baseURL && this.cfg.model && (this.cfg.key || this.envKeyReady(this.cfg.baseURL)));
  },

  statusText() {
    if (this.cfg.provider === 'demo') return '离线演示模式：返回预置文案（不联网）';
    const viaProxy = this.server && this.server.proxy;
    const keyFrom = this.cfg.key ? '页面配置的 key' : (viaProxy ? '本地环境变量 key' : '未配置 key');
    return `${this.cfg.model} · ${viaProxy ? '经本地 serve.py 代理' : '浏览器直连'} · ${keyFrom}`;
  },

  // 统一入口：messages=[{role, content}]，opts={task:'explain'|'qa'|'nlplan', temperature, maxTokens}
  async chat(messages, opts = {}) {
    if (this.cfg.provider === 'demo') {
      await new Promise(r => setTimeout(r, 350)); // 模拟一点延迟，演示更真实
      return { ok: true, content: this._demo(messages, opts.task || ''), via: 'demo' };
    }
    const body = {
      baseURL: this.cfg.baseURL,
      model: this.cfg.model,
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (this.cfg.key) headers['X-Api-Key'] = this.cfg.key;

    // DeepSeek 官方没有 CORS：没本地代理就直接给可行动的报错
    if (!this.server) {
      const host = this.cfg.baseURL.toLowerCase();
      if (host.includes('api.deepseek.com')) {
        return { ok: false, via: 'direct', error: 'DeepSeek 官方接口不允许浏览器直连（CORS）。请在 prototype 目录运行 `python serve.py` 后从 http://127.0.0.1:8765/travel.html 打开本页，或改用 OpenRouter（有免费模型）。' };
      }
    }
    const useProxy = !!this.server;
    try {
      const r = await fetch(useProxy ? '/api/llm' : (this.cfg.baseURL.replace(/\/$/, '') + '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify(useProxy ? body : {
          model: this.cfg.model,
          messages,
          stream: false,
          ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (useProxy) return data; // serve.py 已归一化 {ok, content, error}
      const content = data.choices && data.choices[0] && data.choices[0].message
        ? (data.choices[0].message.content || '') : '';
      if (!r.ok) return { ok: false, via: 'direct', error: `上游返回 ${r.status}：${JSON.stringify(data).slice(0, 300)}` };
      return { ok: true, content, via: 'direct' };
    } catch (e) {
      return { ok: false, via: useProxy ? 'proxy' : 'direct', error: `请求失败：${e.message}` };
    }
  },

  // 从任意 LLM 文本里抠出 JSON（容忍 ```json 围栏 / 前后废话）
  extractJSON(text) {
    if (!text) return null;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [];
    if (fence) candidates.push(fence[1]);
    const first = text.indexOf('{'), last = text.lastIndexOf('}');
    if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
    for (const c of candidates) {
      try { return JSON.parse(c.trim()); } catch (e) { /* 试下一个 */ }
    }
    return null;
  },

  // 离线演示回复：讲解从消息里的行程 JSON 现场汇总（数据是真的），其余给预置文案
  _demo(messages, task) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (task === 'explain' && lastUser) {
      const payload = this.extractJSON(lastUser.content);
      if (payload && payload.summary) {
        const s = payload.summary;
        const lines = (payload.dayLines || []).map(d =>
          `第 ${d.day} 天（${d.date}）：${d.stops.map(x => x.name).join(' → ') || '自由活动'}`);
        return `【离线演示 · 由页面内结构化行程数据汇总，未调用大模型】\n\n这份 ${s.days} 天的 ${s.from}→${s.to} 行程，城际选择了${s.intercity ? s.intercity.mode : '未选'}${s.intercity && s.intercity.board ? `（${s.intercity.board} 上车）` : ''}，全程约 ${s.total.minutes} 分钟、合计 ${s.total.cost} 元。\n\n${lines.join('\n')}\n\n（离线模式只能做事实汇总；配置 AI 通道后，会基于同一份行程 JSON 生成更自然的讲解、排序理由与贴士。）`;
      }
    }
    if (task === 'nlplan') {
      return '【离线演示】解析结果（演示固定值，真实版由 LLM 解析任意语句）：\n{"city":"成都","days":3,"party":"朋友结伴","budget":2500,"interests":["热门","美食"]}\n\n离线模式也支持「城市 + N 天」的极简格式，例如：成都 3 天';
    }
    return '【离线演示回复】当前未配置 AI 通道。打开右上角「✨ AI 设置」接入 DeepSeek / OpenRouter 即可获得真实问答；本页攻略库中的条目可直接检索使用。';
  },
};

AI.load();
