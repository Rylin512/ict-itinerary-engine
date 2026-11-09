/* 地图服务路由层：百度 / 高德 一键切换 + 统一排队
 *
 * 背景：两家开放平台的配额都按「次/秒」限，且额度有限。把路线规划、POI 检索
 * 这些高频调用做成可切换的能力，既能摊薄单家压力，也能在某一家的 key 失效、
 * 额度用尽时自动降级到另一家。
 *
 * 约定：
 *  - 所有上游请求都经本地 serve.py（key 不落前端）；
 *  - 服务端已按供应商各自节流，前端再加一层串行队列，避免并发把线程堆满；
 *  - 返回结构与旧 BAIDU 适配层保持一致，travel.js 不用感知供应商差异。
 */
'use strict';

const MAPS = {
  provider: 'auto',          // auto | baidu | amap
  ready: false,              // 任意一家可用
  providers: {},             // { baidu: {ready, browserAK, minInterval}, amap: {...} }
  LS_PROVIDER: 'travel.map.provider',
  MIN_INTERVAL: 550,
  lastError: '',
  lastUsed: '',              // 上一次实际命中的供应商，用于界面标注

  load() {
    try {
      this.provider = localStorage.getItem(this.LS_PROVIDER) || 'auto';
    } catch (e) { this.provider = 'auto'; }
    this.loadPrefs();
  },
  save() {
    try { localStorage.setItem(this.LS_PROVIDER, this.provider); } catch (e) { /* 忽略 */ }
  },

  // —— 高级：按能力指定供应商（默认 auto，走服务端分流） ——
  prefs: { route: 'auto', place: 'auto' },
  LS_PREFS: 'travel.map.prefs',
  loadPrefs() {
    try {
      const raw = localStorage.getItem(this.LS_PREFS);
      if (raw) {
        const p = JSON.parse(raw) || {};
        this.prefs = { route: p.route || 'auto', place: p.place || 'auto' };
      }
    } catch (e) { this.prefs = { route: 'auto', place: 'auto' }; }
  },
  savePrefs() {
    try { localStorage.setItem(this.LS_PREFS, JSON.stringify(this.prefs)); } catch (e) { /* 忽略 */ }
  },
  isCustom() {
    return this.prefs.route !== 'auto' || this.prefs.place !== 'auto';
  },
  providerFor(kind) {
    const p = this.prefs[kind];
    return p && p !== 'auto' ? p : this.provider;
  },

  label(name) {
    return ({ baidu: '百度地图', amap: '高德地图' })[name] || name || '';
  },

  async probe() {
    this.lastError = '';
    if (!location.protocol.startsWith('http')) { this.ready = false; return false; }
    try {
      const r = await fetch('/api/map/config', { cache: 'no-store' });
      const cfg = r.ok ? await r.json() : null;
      if (cfg && cfg.providers) {
        this.providers = cfg.providers;
        const b = cfg.providers.baidu || {};
        const a = cfg.providers.amap || {};
        BAIDU.ready = !!b.ready;
        if (b.browserAK && !BAIDU.browserKey) {
          BAIDU.browserKey = b.browserAK;
          BAIDU.browserFromEnv = true;
        }
        if (a.browserAK) AMAP.key = a.browserAK;
        if (!localStorage.getItem(this.LS_PROVIDER) && cfg.default) this.provider = cfg.default;
        const iv = Math.max((b.minInterval || 550), (a.minInterval || 0));
        this.MIN_INTERVAL = iv || 550;
        this.ready = !!(b.ready || a.ready);
        return this.ready;
      }
    } catch (e) { /* 落到下面的兼容探测 */ }
    // 老版本服务端没有 /api/map/config：退回百度单供应商
    this.ready = await BAIDU.probe();
    this.providers = { baidu: { ready: BAIDU.ready } };
    return this.ready;
  },

  available() {
    if (!location.protocol.startsWith('http')) return false;
    return this.ready || !!(this.providers.baidu && this.providers.baidu.ready) ||
      !!(this.providers.amap && this.providers.amap.ready);
  },

  statusText() {
    const name = this.isCustom()
      ? `自定义（路线 ${this.label(this.prefs.route) || '自动'} / 地点 ${this.label(this.prefs.place) || '自动'}）`
      : (this.provider === 'auto' ? '自动（按能力分流）' : this.label(this.provider));
    const b = this.providers.baidu && this.providers.baidu.ready ? '百度 ✓' : '百度 ✗';
    const a = this.providers.amap && this.providers.amap.ready ? '高德 ✓' : '高德 ✗';
    const used = this.lastUsed ? ` · 上次命中：${this.label(this.lastUsed)}` : '';
    return `地图服务：${name} · ${b} / ${a}${used}`;
  },

  // —— 一键切换：auto → baidu → amap → auto ——
  cycle() {
    const order = ['auto', 'baidu', 'amap'];
    const next = order[(order.indexOf(this.provider) + 1) % order.length];
    this.provider = next;
    this.save();
    return next;
  },

  // —— 上游调用排队（与服务端闸门同频） ——
  _queue: [],
  _running: false,
  enqueue(task) {
    return new Promise((resolve, reject) => {
      this._queue.push({ task, resolve, reject });
      this._pump();
    });
  },
  _pump() {
    if (this._running) return;
    const job = this._queue.shift();
    if (!job) return;
    this._running = true;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
      setTimeout(() => { this._running = false; this._pump(); }, this.MIN_INTERVAL);
    });
  },

  async _post(path, body, timeoutMs = 60000, kind = 'route') {
    this.lastError = '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (BAIDU.key) headers['X-Baidu-Ak'] = BAIDU.key;
      const r = await fetch(path, {
        method: 'POST', headers,
        body: JSON.stringify(Object.assign({ provider: this.providerFor(kind) }, body)),
        signal: ctrl.signal,
      });
      const data = await r.json();
      if (!data.ok) {
        this.lastError = data.error || '地图服务请求失败';
        return null;
      }
      if (data.provider) this.lastUsed = data.provider;
      return data;
    } catch (e) {
      this.lastError = (e && e.name === 'AbortError') ? '请求超时，请重试' : '网络异常，请检查连接';
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  // —— 路线：driving / walking / riding / transit ——
  async route(a, b) {
    return this.routeMode(a, b, 'driving');
  },

  async routeMode(a, b, mode = 'driving', city1, city2) {
    if (!this.available()) return null;
    return this.enqueue(async () => {
      const body = { from: [a.lng, a.lat], to: [b.lng, b.lat], mode };
      if (mode === 'transit') { body.city1 = city1; body.city2 = city2; }
      const data = await this._post('/api/map/route', body, 20000, 'route');
      if (!data) return null;
      return {
        km: data.km, min: data.min, roadMin: data.min,
        path: data.path || [], cost: data.cost, mode: data.mode || mode,
        segments: data.segments || [],
        provider: data.provider,
      };
    });
  },

  // —— 地点检索（高德没有出入口字段，hasNav 会是 false） ——
  async searchPlaces(query, region, pageSize = 10) {
    if (!this.available()) return [];
    const data = await this._post('/api/map/place', { query, region, pageSize }, 60000, 'place');
    return (data && data.places) || [];
  },

  async suggestPlaces(query, region) {
    return this.searchPlaces(query, region, 8);
  },

  // 详情只有百度有（出入口坐标）；高德结果直接返回 null，调用方回退到中心点
  async placeDetail(uid) {
    if (!uid || String(uid).startsWith('amap:')) return null;
    if (!this.providers.baidu || !this.providers.baidu.ready) return null;
    return BAIDU.placeDetail(uid);
  },

  // —— 导航深链：按当前供应商跳到对应 App ——
  navUrl(fromPt, toPt, mode, region) {
    const useAmap = this.provider === 'amap' ||
      (this.provider === 'auto' && this.lastUsed === 'amap');
    if (!useAmap) return BAIDU.navUrl(fromPt, toPt, mode, region);
    const m = { walking: 'walk', riding: 'ride', transit: 'bus', driving: 'car' }[mode] || 'car';
    const p = pt => `${pt.lng.toFixed(6)},${pt.lat.toFixed(6)}`;
    return `https://uri.amap.com/navigation?from=${p(fromPt)},起点&to=${p(toPt)},终点`
      + `&mode=${m}&policy=1&src=itinerary-engine&coordinate=gaode&callnative=0`;
  },
};

MAPS.load();

/* 高德 JS API 2.0 加载器（浏览器端 key）
 * 与服务端 key 分开：这个只用于地图展示层，key 走 Referer 白名单保护。 */
const AMAP = {
  key: '',
  glReady: false,
  _promise: null,

  load() {
    if (this.glReady) return Promise.resolve(true);
    if (typeof AMap !== 'undefined') { this.glReady = true; return Promise.resolve(true); }
    if (!this.key) return Promise.resolve(false);
    if (this._promise) return this._promise;
    this._promise = new Promise(resolve => {
      const done = ok => { this.glReady = ok; resolve(ok); };
      const s = document.createElement('script');
      window.__amapReady = () => done(true);
      s.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(this.key)}&callback=__amapReady`;
      s.onerror = () => done(false);
      document.head.appendChild(s);
      setTimeout(() => { if (!this.glReady) done(false); }, 7000);
    });
    return this._promise;
  },
};
