/* 百度地图开放平台适配层（双 AK 架构）
 *
 * ① 服务器端 AK（Web 服务 API，如 direction/v2 路线规划）
 *    - 推荐配在 serve.py 环境变量 BAIDU_MAP_AK（IP 白名单校验，AK 不落前端）
 *    - 也可在设置面板粘贴，存 localStorage，经请求头 X-Baidu-Ak 传给本地代理
 * ② 浏览器端 AK（JS API GL，地图展示层）
 *    - 存 localStorage；配置后底图由 OSM 切换为原生百度地图（刷新生效）
 *    - AK 属敏感凭据：两者都不会写进代码仓库
 *
 * 坐标约定：页面数据为 GCJ-02 近似值；
 *  - Web 服务请求带 coord_type=gcj02，由百度侧转换；
 *  - JS API GL 只认 BD-09，用 gcj2bd() 本地闭合公式转换（GCJ→BD 为确定性变换）。
 * 无 AK / 无本地服务时全部回退：驾车里程 OSRM → 直线公式；底图 OSM。
 */
'use strict';

const BAIDU = {
  // —— 服务器端 AK ——
  ready: false,  // 探测结果：本地代理 + AK 是否可用
  key: '',       // 面板粘贴的服务器端 AK（可选，优先于环境变量）
  // —— 浏览器端 AK ——
  browserKey: '',
  browserFromEnv: false,   // true 表示来自本地 serve.py 的环境变量，不写回 localStorage
  glReady: false,

  LS_SERVER: 'travel.baidu.ak',
  LS_BROWSER: 'travel.baidu.akBrowser',

  load() {
    try {
      this.key = localStorage.getItem(this.LS_SERVER) || '';
      this.browserKey = localStorage.getItem(this.LS_BROWSER) || '';
    } catch (e) { this.key = ''; this.browserKey = ''; }
  },
  save() {
    try {
      const set = (k, v) => v ? localStorage.setItem(k, v) : localStorage.removeItem(k);
      set(this.LS_SERVER, this.key);
      set(this.LS_BROWSER, this.browserKey);
    } catch (e) { /* 忽略 */ }
  },

  async probe() {
    if (!location.protocol.startsWith('http')) { this.ready = false; return this.ready; }
    try {
      const r = await fetch('/api/baidu-config', { cache: 'no-store' });
      const cfg = r.ok ? await r.json() : null;
      this.ready = !!(cfg && cfg.ready);
      // 本地环境变量里配了浏览器端 AK：页面自动使用，无需在设置面板粘贴
      if (cfg && cfg.browserAK && !this.browserKey) {
        this.browserKey = cfg.browserAK;
        this.browserFromEnv = true;
      }
      if (cfg && cfg.minInterval) this.MIN_INTERVAL = cfg.minInterval;
    } catch (e) { this.ready = false; }
    return this.ready;
  },

  // —— 上游调用统一排队 ——
  // 两个 AK 都是 2 次/秒上限：服务端 baidu_gate() 做全局节流，
  // 前端也串行化，避免一次渲染几十个路段把服务端线程堆满、并让请求提前超时。
  MIN_INTERVAL: 550,
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

  serverStatus() {
    if (this.ready) return '服务器端 AK 生效（环境变量）· 路网里程来自百度 direction/v2';
    if (this.key) return '服务器端 AK 生效（面板粘贴）· 路网里程来自百度 direction/v2';
    return '未配置：路网里程回退 OSRM 估算';
  },
  browserStatus() {
    if (this.browserFromEnv) return '浏览器端 AK 生效（本地环境变量）· 底图使用百度地图 JS API GL';
    return this.browserKey
      ? '浏览器端 AK 已配置 · 底图使用百度地图 JS API GL（保存后刷新生效）'
      : '未配置：底图使用 OpenStreetMap（免 key）';
  },

  // —— 百度 URI API 导航深链（免 AK，浏览器直接打开百度地图网页版） ——
  navUrl(fromPt, toPt, mode, region) {
    const pp = pt => `${pt.lat.toFixed(6)},${pt.lng.toFixed(6)}`;
    return `https://api.map.baidu.com/direction?origin=${pp(fromPt)}&destination=${pp(toPt)}`
      + `&mode=${mode}&region=${encodeURIComponent(region || '')}`
      + `&coord_type=gcj02&output=html&src=ict-itinerary-engine`;
  },

  // —— 驾车路网（km / 分钟）：本地代理 → 百度 Web 服务；不可用返回 null ——
  // 所有上游调用都进队列：两个 AK 都限 2 次/秒，服务端还有一道全局闸门。
  async route(a, b) {
    if ((!this.ready && !this.key) || !location.protocol.startsWith('http')) return null;
    return this.enqueue(() => this._routeOnce(a, b));
  },

  async _routeOnce(a, b) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.key) headers['X-Baidu-Ak'] = this.key;
      const r = await fetch('/api/baidu/driving', {
        method: 'POST', headers,
        body: JSON.stringify({ from: [a.lng, a.lat], to: [b.lng, b.lat] }),
        signal: ctrl.signal,
      });
      const data = await r.json();
      if (!data.ok) return null;
      return { km: data.km, roadMin: data.min };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  // —— GCJ-02 → BD-09（闭合公式，确定性） ——
  gcj2bd(lat, lng) {
    const xPI = Math.PI * 3000 / 180;
    const x = lng, y = lat;
    const z = Math.sqrt(x * x + y * y) + 0.00002 * Math.sin(y * xPI);
    const theta = Math.atan2(y, x) + 0.000003 * Math.cos(x * xPI);
    return { lng: z * Math.cos(theta) + 0.0065, lat: z * Math.sin(theta) + 0.006 };
  },
  bd(pt) { const c = this.gcj2bd(pt.lat, pt.lng); return new BMapGL.Point(c.lng, c.lat); },

  // —— JS API GL 加载（浏览器端 AK）——
  loadGL() {
    if (this.glReady) return Promise.resolve(true);
    if (typeof BMapGL !== 'undefined') { this.glReady = true; return Promise.resolve(true); }
    if (!this.browserKey) return Promise.resolve(false);
    return new Promise(resolve => {
      const s = document.createElement('script');
      const done = ok => { this.glReady = ok; resolve(ok); };
      s.src = `https://api.map.baidu.com/api?v=1.0&type=webgl&ak=${encodeURIComponent(this.browserKey)}&callback=__bmapGLReady`;
      s.onerror = () => done(false);
      window.__bmapGLReady = () => done(true);
      document.head.appendChild(s);
      setTimeout(() => { if (!this.glReady) done(false); }, 6000);
    });
  },
};

BAIDU.load();
