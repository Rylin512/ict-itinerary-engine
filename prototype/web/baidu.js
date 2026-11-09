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

  // —— 地点结果本地缓存：同一关键词 / uid 不再重复请求百度 ——
  // 服务端 .cache/baidu.json 也会持久化；这里加一层浏览器缓存，刷新页面也免请求。
  LS_CACHE: 'travel.baidu.results.v1.',
  CACHE_TTL: 30 * 86400 * 1000,
  _cacheGet(key) {
    try {
      const raw = localStorage.getItem(this.LS_CACHE + key);
      if (!raw) return null;
      const item = JSON.parse(raw);
      if (!item || Date.now() - (item.t || 0) > this.CACHE_TTL) {
        localStorage.removeItem(this.LS_CACHE + key);
        return null;
      }
      return item.v;
    } catch (e) { return null; }
  },
  _cacheSet(key, value) {
    try {
      localStorage.setItem(this.LS_CACHE + key, JSON.stringify({ t: Date.now(), v: value }));
    } catch (e) {
      // 配额满时清掉最早的一批地点缓存后重试一次
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(this.LS_CACHE)) keys.push(k);
        }
        keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => localStorage.removeItem(k));
        localStorage.setItem(this.LS_CACHE + key, JSON.stringify({ t: Date.now(), v: value }));
      } catch (e2) { /* 忽略 */ }
    }
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

  // —— 路线请求排队 ——
  // 两个 AK 都是 2 次/秒上限：服务端 baidu_gate() 做全局节流，
  // 前端把路线请求也串行化，避免一次渲染几十个路段把服务端线程堆满。
  // 地点检索 / 模糊搜索 / 详情走服务端优先闸门，不排这个队列（见下方说明）。
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

  available() {
    return (this.ready || !!this.key) && location.protocol.startsWith('http');
  },

  serverStatus() {
    if (this.ready) return '服务器端 AK 生效（环境变量）· 地点检索 / 路线规划来自百度';
    if (this.key) return '服务器端 AK 生效（面板粘贴）· 地点检索 / 路线规划来自百度';
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
      + `&coord_type=gcj02&output=html&src=itinerary-engine`;
  },

  // —— 地点检索 / 模糊搜索 / 详情：本地代理 → 百度 place/v2 ——
  // 返回 [{name,address,lng,lat,navLng,navLat,hasNav,tag,uid,tel}]；不可用返回 []。
  //
  // 这三类请求**不进前端队列**：行程一算就是十几条路线请求，排队会让一次酒店
  // 搜索干等十几秒（旧版 15s 超时因此经常 abort）。服务端 baidu_gate(priority)
  // 已保证 ≤2 QPS，并让地点请求插到路线请求前面，所以直接发即可。
  // 超时放宽到 60s，只在服务端真的长时间排队时才触发。
  lastError: '',

  async _postJson(path, body, timeoutMs = 60000) {
    this.lastError = '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.key) headers['X-Baidu-Ak'] = this.key;
      const r = await fetch(path, {
        method: 'POST', headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        this.lastError = `本地服务返回 ${r.status}`;
        return null;
      }
      const data = await r.json();
      if (!data.ok) {
        this.lastError = data.error || '百度请求失败';
        return null;
      }
      return data;
    } catch (e) {
      this.lastError = (e && e.name === 'AbortError')
        ? '请求超时，请重试'
        : '网络异常，请检查连接后重试';
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  // 精确 POI 检索：带 detail_info.navi_location（景点/酒店真实出入口）。
  // 百度不可用 / 额度用完 / 结果为空时，自动落到 OpenStreetMap 免费地点库。
  async searchPlaces(query, region, pageSize = 10) {
    const key = `place|${region || ''}|${query}|${pageSize}`;
    const cached = this._cacheGet(key);
    if (cached) return cached;
    let places = [];
    if (this.available()) {
      const data = await this._postJson('/api/baidu/place', { query, region, pageSize });
      places = (data && data.places) || [];
    }
    if (!places.length) {
      places = await FREE.places(query, region, pageSize);
      if (places.length) this.lastError = '';
    }
    if (places.length) this._cacheSet(key, places);
    return places;
  },

  // 模糊搜索：用户只记得半截关键词时也能列出候选（无出入口坐标，选中后补详情）
  async suggestPlaces(query, region) {
    const key = `suggest|${region || ''}|${query}`;
    const cached = this._cacheGet(key);
    if (cached) return cached;
    let places = [];
    if (this.available()) {
      const data = await this._postJson('/api/baidu/suggest', { query, region });
      places = (data && data.places) || [];
    }
    if (!places.length) {
      places = await FREE.places(query, region, 8);
      if (places.length) this.lastError = '';
    }
    if (places.length) this._cacheSet(key, places);
    return places;
  },

  // 用候选的 uid 取详情：拿到 navi_location 后再按酒店实际出入口算路线
  async placeDetail(uid) {
    if (!this.available() || !uid) return null;
    const key = `detail|${uid}`;
    const cached = this._cacheGet(key);
    if (cached) return cached;
    const data = await this._postJson('/api/baidu/detail', { uid });
    const place = (data && data.place) || null;
    if (place) this._cacheSet(key, place);
    return place;
  },

  // —— 驾车路网（km / 分钟）：兼容旧调用，等同 routeMode(..., 'driving') ——
  async route(a, b) {
    return this.routeMode(a, b, 'driving');
  },

  // —— 多模式路线（driving / walking / riding / transit）——
  // 返回 {km, min, roadMin, path:[[lng,lat],...], cost?, mode}；
  // path 是该路段真实道路折线（GCJ-02），用于聚合绘制完整线路图。
  async routeMode(a, b, mode = 'driving', city1, city2) {
    if (!this.available()) return null;
    return this.enqueue(() => this._routeOnce(a, b, mode, city1, city2));
  },

  async _routeOnce(a, b, mode, city1, city2) {
    this.lastError = '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.key) headers['X-Baidu-Ak'] = this.key;
      const body = { from: [a.lng, a.lat], to: [b.lng, b.lat], mode };
      if (mode === 'transit') { body.city1 = city1; body.city2 = city2; }
      const r = await fetch('/api/baidu/route', {
        method: 'POST', headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await r.json();
      if (!data.ok) {
        this.lastError = data.error || '';
        return null;
      }
      return {
        km: data.km, min: data.min, roadMin: data.min,
        path: data.path || [], cost: data.cost, mode: data.mode || mode,
        segments: data.segments || [],  // 公交：步行/地铁/公交的换乘组成
      };
    } catch (e) {
      this.lastError = (e && e.name === 'AbortError') ? '路线请求超时' : '网络异常，路线请求失败';
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
  // 并发调用共用同一个 Promise：地图初始化失败重试时不会反复插入 <script>。
  loadGL() {
    if (this.glReady) return Promise.resolve(true);
    if (typeof BMapGL !== 'undefined') { this.glReady = true; return Promise.resolve(true); }
    if (!this.browserKey) return Promise.resolve(false);
    if (this._glPromise) return this._glPromise;
    this._glPromise = new Promise(resolve => {
      const s = document.createElement('script');
      const done = ok => { this.glReady = ok; resolve(ok); };
      s.src = `https://api.map.baidu.com/api?v=1.0&type=webgl&ak=${encodeURIComponent(this.browserKey)}&callback=__bmapGLReady`;
      s.onerror = () => done(false);
      window.__bmapGLReady = () => done(true);
      document.head.appendChild(s);
      setTimeout(() => { if (!this.glReady) done(false); }, 6000);
    });
    return this._glPromise;
  },
};

BAIDU.load();

/* 免费地点数据（OpenStreetMap / Nominatim / Overpass）
 * 服务端已做 1 次/秒限流和持久缓存；这里只负责请求与错误处理。
 * 不消耗百度配额，作为百度地点/景点搜索不可用或结果为空时的兜底。 */
const FREE = {
  lastError: '',

  async _get(path, params, timeoutMs = 35000) {
    this.lastError = '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const qs = new URLSearchParams(params).toString();
      const r = await fetch(`${path}?${qs}`, { signal: ctrl.signal, cache: 'no-store' });
      const data = r.ok ? await r.json() : null;
      if (!data || !data.ok) {
        this.lastError = (data && data.error) || `免费数据服务返回 ${r.status}`;
        return null;
      }
      return data;
    } catch (e) {
      this.lastError = e && e.name === 'AbortError'
        ? '免费数据源请求超时'
        : '免费数据源网络异常';
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  // Nominatim 免费地理编码：q + 城市，返回统一地点结构（GCJ-02）
  async places(query, city, limit = 8) {
    const data = await this._get('/api/free/places', {
      q: query, city: city || '', limit,
    });
    return (data && data.places) || [];
  },

  // Overpass 免费景点发现：未收录城市用城市中心坐标查周边景点
  async attractions(city, center, limit = 30) {
    if (!center || center.lat == null || center.lng == null) return [];
    const data = await this._get('/api/free/attractions', {
      city: city || '', lat: center.lat, lng: center.lng, limit,
    }, 40000);
    return (data && data.places) || [];
  },
};
