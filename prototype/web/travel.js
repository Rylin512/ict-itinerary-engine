/* 跨城出行规划 · 页面逻辑（时间段 + 分天安排版）
 * 数据在 travel-data.js（全国地级行政区 + 41 城分级景点 + 车站/机场表 + 出租车计价表，示意/事实混标）；
 * 攻略库在 travel-guides.js（演示数据）；AI 通道在 ai.js（DeepSeek/OpenRouter…，离线演示兜底）。
 * 城际交通按距离估算但落位到具体车站/机场（STATIONS），接真实票务 API 后替换 intercityOptions；
 * 打车费用 = 出租车计价表 + OSRM 公开路网里程（滴滴/哈罗无公开 API，预留适配位）。
 * 分天引擎：地理聚类（k-means）+ 容量平衡 + 每天独立求最优顺序。
 */
'use strict';

/* ================= 构建索引 ================= */

const CITIES = [];
PROVINCE_CITIES.forEach(([province, list]) => {
  list.forEach(([name, lng, lat]) => {
    CITIES.push({ name, province, lat, lng, curated: !!POI_RAW[name] });
  });
});
const CITYMAP = {};
CITIES.forEach(c => { CITYMAP[c.name] = c; });
const CURATED_CITIES = CITIES.filter(c => c.curated);

const POIS = {};
const POIMAP = {};
Object.keys(POI_RAW).forEach(city => {
  POIS[city] = POI_RAW[city].map(([name, lat, lng, tier, ticket, suggest_min, satisfaction, note]) => {
    const id = LEGACY_POI_IDS[name] || `${name}@${city}`;
    const p = { id, name, lat, lng, tier, ticket, suggest_min, satisfaction, note, city };
    POIMAP[id] = p;
    return p;
  });
});

const TIERS_ALL = ['hot', 'value', 'niche', 'explore'];

/* ================= 小工具 ================= */

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

function hav(a, b) {
  const r = Math.PI / 180, R = 6371;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const roadKm = (a, b) => hav(a, b) * 1.35;

function fmtDur(min) {
  min = Math.round(min);
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60), m = min % 60;
  return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
}
const fmtCost = c => (!c || c <= 0) ? '免费' : '¥' + Math.round(c);
const fmtKm = km => km >= 100 ? Math.round(km) + ' km' : km.toFixed(1) + ' km';

/* 日期 / 时刻 */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad2 = n => String(n).padStart(2, '0');
function dateObj(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function addDaysStr(s, n) { const d = dateObj(s); d.setDate(d.getDate() + n); return fmtISO(d); }
function fmtDateCN(s) { const d = dateObj(s); return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WEEK[d.getDay()] + '）'; }
function toMin(hm) { if (!hm) return null; const [h, m] = hm.split(':').map(Number); return h * 60 + m; }
function fmtHM(min) { min = ((Math.round(min) % 1440) + 1440) % 1440; return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60); }

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ================= 状态 ================= */

const state = {
  from: CITYMAP['上海'],
  to: CITYMAP['成都'],
  arriveDate: '',
  returnDate: '',
  departTime: '',   // 'HH:MM' 或 ''
  returnTime: '',
  days: [],          // 每天的 ISO 日期
  transport: null,
  intercity: null,
  selected: [],
  orders: {},        // {recommended:[[dayIds]], popular:[[..]], custom:[[..]]}
  scheme: 'recommended',
  modes: [],         // 所有天的通勤方式，扁平数组
  withTicket: true,
  step: 1,
  maxStep: 1,
  spotTier: 'all',
  departPoint: null,     // 去车站/机场的出发点 {name, lat, lng, custom?}；null=住宿枢纽
  boardStations: {},     // 用户手选的上/下车站，键 'from:hsr' / 'to:flight'
  access: null,          // 接驳估算 {from:{taxi,transit,src}, to:{...}}；null=暂无
  hotels: {},            // 目的地城市 -> 用户选定的酒店 {name,address,lat,lng,addrLat,addrLng,hasNav}
  guideTab: 'food',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function hubOf(c) {
  const pick = state.hotels[c.name];
  if (pick) {
    return {
      name: pick.name || '已选酒店', lat: pick.lat, lng: pick.lng, isHub: true,
      hotel: true, address: pick.address || '', hasNav: !!pick.hasNav,
    };
  }
  const h = HUBS[c.name];
  if (h) return { name: h[0], lat: h[1], lng: h[2], isHub: true };
  return { name: '市中心（默认住宿）', lat: c.lat, lng: c.lng, isHub: true };
}

/* ================= 车站 / 接驳 / 打车估算 ================= */

/* --- 出租车：计价表（TAXI_TARIFF）+ OSRM 公开路网真实里程。
 * 滴滴 / 哈罗没有公开的估价 API（需企业签约），这里预留 RideHailingProvider 适配位：
 * 未来拿到资质后，把 pairEstimate 里的 taxi 分支换成真实接口返回即可，UI 不用动。 --- */
function tariffOf(cityName) {
  return (TAXI_TARIFF.cities && TAXI_TARIFF.cities[cityName]) || TAXI_TARIFF.fallback;
}
function taxiFare(cityName, km) {
  const t = tariffOf(cityName);
  const mid = Math.min(km, t.farKm);
  const cost = t.start + Math.max(0, mid - t.startKm) * t.perKm + Math.max(0, km - t.farKm) * t.farK;
  return Math.max(t.start, Math.round(cost));
}
function taxiSync(cityName, km) {
  return { min: km / 26 * 60 + 6, cost: taxiFare(cityName, km), km, src: '估算' };
}
function transitSync(km) { // 公交地铁启发式（无实时数据），长距离不展示（快线/城际难以估准）
  return { min: Math.min(240, Math.max(10, km / 22 * 60 + 12)), cost: km > 10 ? 6 : 3, km, src: '估算' };
}

const osrmCache = new Map();
async function osrmRoute(a, b) { // 免 key、支持浏览器跨域；失败回退直线估算
  const key = pairKey(a, b);
  if (osrmCache.has(key)) return osrmCache.get(key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false&alternatives=false`, { signal: ctrl.signal });
    const data = await r.json();
    if (data.code !== 'Ok' || !data.routes || !data.routes[0]) throw new Error('no route');
    const res = { km: data.routes[0].distance / 1000, roadMin: data.routes[0].duration / 60 };
    osrmCache.set(key, res);
    return res;
  } catch (e) {
    osrmCache.set(key, null);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pairEstimate(cityName, a, b) { // 单对点估算：百度路网（需 AK）→ OSRM（免 key）→ 直线公式
  const km0 = roadKm(a, b);
  const est = {
    taxi: taxiSync(cityName, km0),
    transit: transitSync(km0),
    src: '估算',
  };
  const baidu = await MAPS.route(a, b);
  const r = baidu || await osrmRoute(a, b);
  if (r) {
    est.src = baidu ? '百度地图路网' : 'OSRM 实际路网';
    est.taxi = { min: r.roadMin + 6, cost: taxiFare(cityName, r.km), km: r.km, src: est.src };
    est.transit = transitSync(r.km);
  }
  return est;
}

const pairKey = (a, b) => `${a.lng.toFixed(4)},${a.lat.toFixed(4)}|${b.lng.toFixed(4)},${b.lat.toFixed(4)}`;
const routeEst = new Map();      // pairKey -> pairEstimate 结果（全程共享缓存）
const routeGeo = new Map();      // `${mode}|${pairKey}` -> 百度实际路线 {path,km,min,cost}
let routesSeq = 0;               // 状态变更后丢弃过期的异步结果
let geoToken = 0;                // 起终点/酒店变化后作废在途的路线几何请求
let fastestToken = 0;            // 作废在途的「最快组合」计算

function resetRoutes() {         // 酒店或景点坐标变化后，旧路网缓存全部失效
  routeEst.clear();
  routeGeo.clear();
  routesSeq++;
  geoToken++;
  fastestToken++;
}

/* --- 景点真实出入口：用百度地点检索的 navi_location 替换 POI 近似坐标 --- */
async function ensureSpotNav() {
  if (!MAPS.available()) return false;
  const todo = state.selected.filter(id => {
    const p = POIMAP[id];
    return p && !p.navTried;
  });
  let changed = false;
  for (const id of todo) {
    const p = POIMAP[id];
    p.navTried = true;
    if (!p.name) continue;
    const places = await MAPS.searchPlaces(p.name, state.to.name, 3);
    const best = places.find(x => x.name === p.name)
      || places.find(x => x.name && (x.name.includes(p.name) || p.name.includes(x.name)))
      || places[0];
    if (!best) continue;
    p.baseLat = p.lat; p.baseLng = p.lng;
    p.lng = best.navLng != null ? best.navLng : best.lng;
    p.lat = best.navLat != null ? best.navLat : best.lat;
    p.address = best.address || p.address || '';
    p.entrance = !!best.hasNav;
    p.navName = best.name;
    changed = true;
  }
  if (changed) resetRoutes();
  return changed;
}

/* --- 车站/机场落位 --- */
function stationsOf(cityName) { return STATIONS[cityName] || null; }
function railStations(cityName) { const s = stationsOf(cityName); return s ? (s.rail || []) : []; }
function airports(cityName) { const s = stationsOf(cityName); return s ? (s.airports || []) : []; }
function pickStation(list, nearPt) { // 主枢纽优先（离出发点不太远时），否则就近
  if (!list || !list.length) return null;
  const main = list.find(s => s.main);
  if (!nearPt) return main || list[0];
  const nearest = list.reduce((m, s) => hav(nearPt, s) < hav(nearPt, m) ? s : m, list[0]);
  if (main && hav(nearPt, main) - hav(nearPt, nearest) < 15) return main;
  return nearest;
}
function stationListFor(modeId, cityName) {
  if (modeId === 'flight') return airports(cityName);
  if (modeId === 'hsr' || modeId === 'train') return railStations(cityName);
  return [];
}
function chosenStation(modeId, side) { // side: 'from' 出发城上车 / 'to' 目的城下车
  const city = side === 'from' ? state.from : state.to;
  const list = stationListFor(modeId, city.name);
  const picked = state.boardStations[side + ':' + modeId];
  // 用户从 12306 / 百度搜索选中的站点可能不在内置表里，有坐标就直接用
  if (picked && picked.lng != null && picked.lat != null) return picked;
  if (picked) return list.find(s => s.name === picked.name) || pickStation(list, null);
  if (!list.length) return null;
  return pickStation(list, side === 'from' ? departPointOf() : hubOf(city));
}
function stationFallback(modeId, cityName) { // 无站点数据时的兜底文案
  const s = stationsOf(cityName);
  if (s) {
    if (modeId === 'flight' && s.airportNote) return s.airportNote;
    if (modeId !== 'flight' && s.railNote) return s.railNote;
  }
  return '该市车站 / 机场数据待收录，按市中心估算接驳';
}
function departPointOf() {
  return state.departPoint || hubOf(state.from);
}

/* --- 接驳估算（出发点→上车站；下车站→住宿地） --- */
function accessPairs() {
  const t = state.transport;
  if (!t) return null;
  return {
    depPt: departPointOf(),
    fromSt: chosenStation(t.id, 'from'),
    toSt: chosenStation(t.id, 'to'),
    destHub: hubOf(state.to),
  };
}
function rebuildAccess() { // 同步基线（直线估算），OSRM 结果由 ensureRoutes 回填
  const p = accessPairs();
  if (!p) { state.access = null; return; }
  const est = (cityName, a, b) => {
    const cached = routeEst.get(pairKey(a, b));
    if (cached) return cached;
    const km = roadKm(a, b);
    return { taxi: taxiSync(cityName, km), transit: transitSync(km), src: '估算' };
  };
  state.access = {
    from: p.fromSt ? est(state.from.name, p.depPt, p.fromSt) : null,
    to: p.toSt ? est(state.to.name, p.toSt, p.destHub) : null,
  };
}
async function ensureRoutes() { // 批量拉真实路网，回来后按当前步骤重渲染
  const order = getOrder();
  const hub = hubOf(state.to);
  const pairs = new Map();
  order.forEach(dayIds => {
    if (!dayIds.length) return;
    const seq = [hub, ...dayIds.map(id => POIMAP[id]), hub];
    for (let k = 1; k < seq.length; k++) {
      const key = pairKey(seq[k - 1], seq[k]);
      if (!routeEst.has(key)) pairs.set(key, [seq[k - 1], seq[k]]);
    }
  });
  const p = accessPairs();
  if (p) {
    if (p.fromSt && !routeEst.has(pairKey(p.depPt, p.fromSt))) pairs.set(pairKey(p.depPt, p.fromSt), [p.depPt, p.fromSt]);
    if (p.toSt && !routeEst.has(pairKey(p.toSt, p.destHub))) pairs.set(pairKey(p.toSt, p.destHub), [p.toSt, p.destHub]);
  }
  if (!pairs.size) return;
  const seqId = ++routesSeq;
  const results = await Promise.all(
    [...pairs.entries()].map(async ([key, [a, b]]) =>
      [key, state.transport ? await pairEstimate(state.to.name, a, b) : null]),
  );
  if (seqId !== routesSeq) return;
  results.forEach(([key, est]) => { if (est) routeEst.set(key, est); });
  rebuildAccess();
  if (state.step === 2) renderTransport();
  if (state.step >= 4) { renderTimeline(); drawRoute(false); }
}

/* 市内 leg 的方式选项：公式基线 + 百度/OSRM 实测修正 */
function realLegCost(modeId, geo) {
  if (!geo) return null;
  if (modeId === 'taxi') return taxiFare(state.to.name, geo.km);
  return geo.cost != null ? geo.cost : null;
}

function legOptsFor(km, a, b) {
  const opts = legOpts(km);
  if (a && b) {
    const e = routeEst.get(pairKey(a, b));
    if (e) {
      const taxi = opts.find(o => o.id === 'taxi');
      if (taxi) { taxi.min = e.taxi.min; taxi.cost = e.taxi.cost; taxi.km = e.taxi.km; }
      const tr = opts.find(o => o.id === 'transit');
      if (tr) { tr.min = e.transit.min; tr.cost = e.transit.cost; }
    }
    // 「最快组合」会把多种方式的真实路线缓存进 routeGeo：逐项用实测值覆盖公式
    opts.forEach(o => {
      const geo = routeGeo.get(`${NAV_MODE[o.id]}|${pairKey(a, b)}`);
      if (!geo) return;
      o.min = geo.min;
      if (geo.km) o.km = geo.km;
      const c = realLegCost(o.id, geo);
      if (c != null) o.cost = c;
      o.real = true;
    });
  }
  return opts;
}

/* ================= 最快组合：逐段用百度实测时长比较多种方式 ================= */

// 等车 / 叫车要留一点固定时间，否则公交和打车会被算得过于理想
const LEG_WAIT_PENALTY = { walk: 0, bike: 0, transit: 4, taxi: 2 };

function fastestCandidates(km0) {
  return legOpts(km0).filter(o => {
    if (o.id === 'walk') return km0 <= 3;   // 超过 3 km 步行不现实，也省一次请求
    if (o.id === 'bike') return km0 <= 8;   // 超过 8 km 骑行不现实
    if (o.id === 'transit' && km0 < 0.8) return false; // 太近，等车比走路还慢
    if (o.id === 'taxi' && km0 < 0.8) return false;
    return true;
  });
}

// 逐段请求步行 / 骑行 / 公交地铁 / 打车，选「实测时长 + 固定等待」最短的一种。
// 每段可以是不同方式；公交地铁本身是「步行 + 地铁/公交」的混合路线。
async function applyFastestModes(btn) {
  if (!state.modes.length) return;
  if (!MAPS.available()) {
    toast('未配置百度服务器端 AK，先按距离智能估算');
    state.modes = state.modes.map((_, i) => {
      const ep = legEndpoints(i);
      return ep ? smartMode(roadKm(ep[0], ep[1])) : state.modes[i];
    });
    renderTimeline();
    drawRoute(false);
    return;
  }
  const token = ++fastestToken;
  const total = state.modes.length;
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.dataset.fastestRun = token; btn.disabled = true; btn.textContent = '对比中…'; }
  showRouteLoading('正在对比最快组合', 0, total);
  let finished = false;
  try {
    for (let i = 0; i < state.modes.length; i++) {
      if (token !== fastestToken) return;
      const ep = legEndpoints(i);
      if (ep) {
        const [a, b] = ep;
        let best = null;
        for (const o of fastestCandidates(roadKm(a, b))) {
          if (token !== fastestToken) return;
          const geo = await ensureGeo(a, b, o.id);
          if (token !== fastestToken) return;
          if (!geo) continue;
          const min = geo.min + (LEG_WAIT_PENALTY[o.id] || 0);
          if (!best || min < best.min) best = { id: o.id, min };
        }
        if (best) state.modes[i] = best.id;
      }
      showRouteLoading('正在对比最快组合', i + 1, total);
    }
    if (token !== fastestToken) return;
    renderTimeline();
    drawRoute(false);
    finished = true;
    toast('已按百度实时时长选出每段最快方式');
  } finally {
    if (btn && +btn.dataset.fastestRun === token) {
      btn.disabled = false;
      btn.textContent = oldText;
      delete btn.dataset.fastestRun;
    }
    // 正常完成时由 drawRoute 决定是否继续显示加载提示；异常退出才在这里收起
    if (!finished && token === fastestToken) hideRouteLoading();
  }
}

function accessTotals() {
  const acc = state.access;
  if (!acc) return { min: 0, cost: 0, fromOnly: 0, toOnly: 0 };
  const from = acc.from || { taxi: { min: 0, cost: 0 } };
  const to = acc.to || { taxi: { min: 0, cost: 0 } };
  return {
    min: from.taxi.min + to.taxi.min,
    cost: from.taxi.cost + to.taxi.cost,
    fromOnly: from.taxi.min,
    toOnly: to.taxi.min,
  };
}

/* ================= 行程窗口 ================= */

// 去程推算：出发时刻 + 接驳到车站 + 城际时长；跨天则第 1 天按晚间自由活动处理
function arrivalInfo() {
  const dep = toMin(state.departTime);
  if (dep == null || !state.transport) return { spill: 0, arriveMin: null };
  const acc = accessTotals();
  // 门到门：出发点 → 上车站 + 城际 + 下车站 → 酒店；第 1 天从酒店开始排
  const total = dep + acc.fromOnly + state.transport.min + acc.toOnly;
  return { spill: Math.floor(total / 1440), arriveMin: total % 1440 };
}

function dayWindows() {
  const D = state.days.length, a = arrivalInfo();
  return state.days.map((ds, i) => {
    let start = 9 * 60, end = 21 * 60 + 30;
    if (i === 0 && a.arriveMin != null) start = a.spill > 0 ? 19 * 60 : a.arriveMin + 60;
    if (i === D - 1 && state.returnTime) end = Math.max(start, toMin(state.returnTime) - 90);
    // 窗口过窄（当晚才到 / 凌晨就走）视为当天不可安排
    const minutes = end - start < 60 ? 0 : end - start;
    return { start, end, minutes };
  });
}

/* ================= 城际交通（示意估算） ================= */

function intercityOptions(a, b) {
  const d = hav(a, b), road = d * 1.2;
  const list = [];
  list.push(d <= 2200
    ? { id: 'hsr', icon: '🚄', name: '高铁 / 动车', min: (d / 280 + 1.2) * 60, cost: Math.round(d * 0.46 / 5) * 5, note: '准点率高，市区车站上下车', ok: true }
    : { id: 'hsr', icon: '🚄', name: '高铁 / 动车', min: 0, cost: 0, note: '', ok: false, why: '超出高铁经济里程' });
  list.push(d >= 600
    ? { id: 'flight', icon: '✈️', name: '飞机', min: (d / 720 + 2.8) * 60, cost: Math.max(400, Math.round(d * 0.6 / 10) * 10), note: '含往返机场 + 值机安检约 2.5 小时', ok: true }
    : { id: 'flight', icon: '✈️', name: '飞机', min: 0, cost: 0, note: '', ok: false, why: '距离较近，通常无航班' });
  list.push({ id: 'train', icon: '🚆', name: '普速火车', min: (d / 110 + 1.5) * 60, cost: Math.round(d * 0.22 / 5) * 5, note: '价格最低，可选夜车省一晚住宿', ok: true });
  list.push({ id: 'car', icon: '🚗', name: '自驾', min: (road / 95 + 1) * 60, cost: Math.round(road * 0.95), note: '含油费 + 过路费估算，人多划算', ok: true });
  list.push(d < 800
    ? { id: 'bus', icon: '🚌', name: '长途大巴', min: (road / 70 + 1) * 60, cost: Math.round(d * 0.24 / 5) * 5, note: '便宜直达，适合短途', ok: true }
    : { id: 'bus', icon: '🚌', name: '长途大巴', min: 0, cost: 0, note: '', ok: false, why: '距离过远，不设班车' });
  return { d, list, popular: d <= 950 ? 'hsr' : 'flight' };
}

function renderTransport() {
  const { d, list, popular } = state.intercity;
  $('#distInfo').textContent =
    `${state.from.name} → ${state.to.name} · 直线约 ${Math.round(d)} km（时间为门到门估算）`;
  const okList = list.filter(o => o.ok);
  const fastest = okList.reduce((m, o) => o.min < m.min ? o : m, okList[0]);
  const cheapest = okList.reduce((m, o) => o.cost < m.cost ? o : m, okList[0]);
  $('#transportList').innerHTML = list.map(o => {
    if (!o.ok) {
      return `<button class="tcard off" disabled>
        <span class="ico">${o.icon}</span>
        <span><span class="name">${o.name}</span><span class="note">${o.why}</span></span>
        <span class="why">不可选</span></button>`;
    }
    const badges = [];
    if (o.id === popular) badges.push('<span class="tb">🔥 大多数人选择</span>');
    if (o.id === fastest.id) badges.push('<span class="tb fast">⚡ 最快</span>');
    if (o.id === cheapest.id) badges.push('<span class="tb cheap">💰 最省钱</span>');
    // 车站/机场落位：高铁/飞机/普速在卡片里直接写明上下车站
    let note = o.note;
    if (o.id === 'hsr' || o.id === 'flight' || o.id === 'train') {
      const fromSt = chosenStation(o.id, 'from');
      const toSt = chosenStation(o.id, 'to');
      note = fromSt && toSt
        ? `📍 ${fromSt.name} → ${toSt.name}`
        : fromSt
          ? `📍 ${fromSt.name} 上车`
          : stationFallback(o.id, state.from.name);
    }
    return `<button class="tcard${state.transport && state.transport.id === o.id ? ' on' : ''}" data-id="${o.id}">
      ${badges.join('')}
      <span class="ico">${o.icon}</span>
      <span><span class="name">${o.name}</span><span class="note">${note}</span></span>
      <span><span class="time">${fmtDur(o.min)}</span><span class="cost" style="display:block">${fmtCost(o.cost)}</span></span>
    </button>`;
  }).join('');
  renderAccessBar();
  renderStationPanel();
}

/* ================= 城际车站 / 机场：搜索、候选、缓存 ================= */

const STATION_LS = 'travel.stations.v1.';
const STATION_TTL = 7 * 86400 * 1000;
let stationSeq = { from: 0, to: 0 };
let stationBusy = { from: false, to: false };
let stationTimer = { from: null, to: null };
let stationExtra = { from: null, to: null };   // {mode, items} 最近一次搜索结果

function resetStationSearch(side) {
  (side ? [side] : ['from', 'to']).forEach(s => {
    stationSeq[s]++;
    stationExtra[s] = null;
    clearTimeout(stationTimer[s]);
    const box = $(`#${s}StationResults`);
    const input = $(`#${s}StationInput`);
    if (box) { box.classList.add('hidden'); box._items = []; }
    if (input) input.value = '';
  });
}
function clearBoardStations(side) {
  ['hsr', 'train', 'flight'].forEach(mode => delete state.boardStations[`${side}:${mode}`]);
}

function stationModeId() {
  const t = state.transport;
  return t && ['hsr', 'train', 'flight'].includes(t.id) ? t.id : null;
}
function stationWord(modeId) { return modeId === 'flight' ? '机场' : '车站'; }
function stationCity(side) { return side === 'from' ? state.from : state.to; }
function stationLsGet(key) {
  try {
    const raw = localStorage.getItem(STATION_LS + key);
    if (!raw) return null;
    const item = JSON.parse(raw);
    if (!item || Date.now() - (item.t || 0) > STATION_TTL) {
      localStorage.removeItem(STATION_LS + key);
      return null;
    }
    return item.v;
  } catch (e) { return null; }
}
function stationLsSet(key, value) {
  try {
    localStorage.setItem(STATION_LS + key, JSON.stringify({ t: Date.now(), v: value }));
  } catch (e) { /* 配额满时忽略，下次仍可走服务端缓存 */ }
}
function stationQueryKey(mode, city, q) { return `${mode}|${city}|${q}`.toLowerCase(); }
function stationHaystack(s) {
  return [s.name, s.city, s.pinyin, s.abbr, s.address].filter(Boolean).join(' ').toLowerCase();
}
function stationMatches(s, q) {
  const needle = q.trim().toLowerCase();
  return !needle || stationHaystack(s).includes(needle);
}
// 12306 用「成都东」，内置表用「成都东站」；去掉后缀再判重，避免同名站出现两次
function stationKey(name) {
  return String(name || '').replace(/\s+/g, '').replace(/(站|机场)$/, '');
}
function stationNormalizePlace(p, source) {
  return {
    name: p.name, address: p.address || '', lng: p.lng, lat: p.lat,
    uid: p.uid, hasNav: !!p.hasNav, note: source,
  };
}
function stationMergeItems(items) {
  const byName = new Map();
  for (const s of items) {
    if (!s || !s.name) continue;
    const key = stationKey(s.name);
    const prev = byName.get(key);
    if (!prev) { byName.set(key, { ...s }); continue; }
    // 同名时保留有坐标 / 信息更全的一条
    if ((prev.lng == null || prev.lat == null) && s.lng != null) {
      byName.set(key, { ...prev, ...s });
    } else if (!prev.address && s.address) {
      byName.set(key, { ...prev, address: s.address });
    }
  }
  return [...byName.values()];
}
function stationCandidates(side) {
  const mode = stationModeId();
  if (!mode) return [];
  const city = stationCity(side);
  const items = [];
  const picked = state.boardStations[side + ':' + mode];
  if (picked) items.push(picked);
  for (const s of stationListFor(mode, city.name)) items.push(s);
  const extra = stationExtra[side];
  if (extra && extra.mode === mode) items.push(...extra.items);
  return stationMergeItems(items);
}
function selectedStation(side) {
  const mode = stationModeId();
  return mode ? state.boardStations[side + ':' + mode] : null;
}

function renderStationPanel() {
  const panel = $('#stationPanel');
  const mode = stationModeId();
  if (!panel) return;
  if (!mode) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const word = stationWord(mode);
  ['from', 'to'].forEach(side => {
    const city = stationCity(side);
    const head = $(`#${side}StationTitle`);
    const input = $(`#${side}StationInput`);
    if (head) {
      head.textContent = `${side === 'from' ? '🛫 出发城市 · 上' : '🛬 目的城市 · 下'}${word}（${city.name}）`;
    }
    if (input) {
      input.placeholder = `搜索${city.name}的${word}，如：${mode === 'flight' ? '天府机场' : '成都东站'}`;
    }
    const box = $(`#${side}StationChips`);
    if (!box) return;
    const items = stationCandidates(side);
    box._items = items;
    const picked = selectedStation(side);
    box.innerHTML = `<button type="button" class="chip${picked ? '' : ' on'}" data-station-side="${side}" data-station-pick="-1">🔄 自动选择</button>`
      + items.slice(0, 12).map((s, i) => {
        const on = picked && picked.name === s.name ? ' on' : '';
        const title = esc(s.note || s.address || '');
        return `<button type="button" class="chip${on}" data-station-side="${side}" data-station-pick="${i}" title="${title}">📍 ${esc(s.name)}</button>`;
      }).join('');
  });
}

function renderStationResults(side, items, note) {
  const box = $(`#${side}StationResults`);
  if (!box) return;
  box.classList.remove('hidden');
  box._items = items;
  if (!items.length) {
    box.innerHTML = `<p class="poi-empty">${esc(note || '没有找到匹配的站点')}`
      + '<br>换个关键词，或检查城市是否选对</p>';
    return;
  }
  box.innerHTML = items.map((s, i) => {
    const meta = s.address || s.note || (s.city ? '12306 车站库' : '百度地图候选');
    const badge = s.lng != null && s.lat != null ? '已定位' : '选中后定位';
    return `<button type="button" class="poi-item" data-station-item="${i}">`
      + `<span class="p-name">${esc(s.name)}</span>`
      + `<span class="p-addr">${esc(meta)}</span>`
      + `<span class="p-badge">${badge}</span>`
      + '</button>';
  }).join('');
}

async function lookupStations(mode, city, q) {
  const key = stationQueryKey(mode, city, q);
  const cached = stationLsGet(key);
  if (cached) return cached;
  const bundled = stationListFor(mode, city);
  let items = bundled.filter(s => stationMatches(s, q)).map(s => ({ ...s, note: s.note || '内置站点' }));
  if (mode === 'flight') {
    if (!items.length) {
      const query = /机场|航站/.test(q) ? q : `${q} 机场`;
      const places = await MAPS.suggestPlaces(query, city);
      items = places
        .filter(p => /机场|航站|航空/.test(`${p.name || ''} ${p.tag || ''}`) || p.tag === '机场')
        .map(p => stationNormalizePlace(p, p.source === 'OpenStreetMap' ? 'OpenStreetMap 候选' : '百度地图候选'));
    }
    items = stationMergeItems(items);
    if (items.length) stationLsSet(key, items);
    return items;
  }
  // 火车：12306 免费车站库优先；内置表里有坐标的站点会自动合并坐标
  try {
    const r = await fetch(`/api/rail-stations?city=${encodeURIComponent(city)}&q=${encodeURIComponent(q)}&limit=30`, { cache: 'no-store' });
    const data = r.ok ? await r.json() : null;
    if (data && data.ok && data.stations) {
      const byName = new Map(bundled.map(s => [stationKey(s.name), s]));
      const rail = data.stations.map(s => {
        const local = byName.get(stationKey(s.name));
        return local
          ? { ...local, city: s.city, pinyin: s.pinyin, abbr: s.abbr, note: local.note || '12306 车站库' }
          : { ...s, note: '12306 车站库' };
      });
      items = stationMergeItems(items.concat(rail));
    }
  } catch (e) { /* 12306 不可用时继续用内置 / 百度兜底 */ }
  if (!items.length) {
    const places = await MAPS.suggestPlaces(q, city);
    items = places.map(p => stationNormalizePlace(p, p.source === 'OpenStreetMap' ? 'OpenStreetMap 候选' : '百度地图候选'));
  }
  items = stationMergeItems(items);
  if (items.length) stationLsSet(key, items);
  return items;
}

async function searchStations(side) {
  clearTimeout(stationTimer[side]);
  const mode = stationModeId();
  if (!mode || stationBusy[side]) return;
  const input = $(`#${side}StationInput`);
  const q = input ? input.value.trim() : '';
  if (!q) return toast(`请输入${stationWord(mode)}名称或关键词`);
  const city = stationCity(side);
  const box = $(`#${side}StationResults`);
  const btn = $(`#btn${side === 'from' ? 'From' : 'To'}StationSearch`);
  const seq = ++stationSeq[side];
  stationBusy[side] = true;
  if (box) {
    box.classList.remove('hidden');
    box._items = [];
    box.innerHTML = '<p class="poi-empty">正在搜索站点…</p>';
  }
  if (btn) { btn.disabled = true; btn.textContent = '搜索中…'; }
  try {
    const items = await lookupStations(mode, city.name, q);
    if (seq !== stationSeq[side] || stationModeId() !== mode) return;
    stationExtra[side] = { mode, items };
    renderStationPanel();
    renderStationResults(side, items, `没有找到「${q}」`);
  } finally {
    stationBusy[side] = false;
    if (btn) { btn.disabled = false; btn.textContent = '搜索'; }
  }
}

async function resolveStationCoords(item, side) {
  const mode = stationModeId();
  const city = stationCity(side);
  let use = { ...item };
  if (use.lng != null && use.lat != null) return use;
  let found = null;
  if (use.uid) found = await MAPS.placeDetail(use.uid);
  if (!found) {
    const places = await MAPS.suggestPlaces(use.name, city.name);
    found = places.find(p => p.name === use.name)
      || places.find(p => (p.name || '').includes(use.name) || use.name.includes(p.name || ''))
      || places[0] || null;
  }
  if (found && found.lng != null && found.lat != null) {
    use = { ...use, ...found, name: use.name || found.name };
  }
  return use; // 仍无坐标时由调用方用市中心兜底
}

async function applyStationCandidate(side, item, btn) {
  const mode = stationModeId();
  if (!mode) return;
  const city = stationCity(side);
  let use = { ...item };
  if (btn) {
    btn.disabled = true;
    const meta = btn.querySelector('.p-addr') || btn.querySelector('.p-badge');
    if (meta) meta.textContent = '正在定位站点坐标…';
  }
  try {
    use = await resolveStationCoords(use, side);
  } catch (e) { /* 定位失败仍允许按市中心选择 */ }
  if (btn) btn.disabled = false;
  if (stationModeId() !== mode) return;
  if (use.lng == null || use.lat == null) {
    use = { ...use, lng: city.lng, lat: city.lat, note: '坐标未定位，按市中心估算' };
    toast(`没定位到「${use.name}」的坐标，先按${city.name}市中心估算接驳`);
  }
  state.boardStations[side + ':' + mode] = {
    name: use.name, lng: use.lng, lat: use.lat,
    address: use.address || '', note: use.note || '',
    hasNav: !!use.hasNav, custom: true,
  };
  const box = $(`#${side}StationResults`);
  if (box) { box.classList.add('hidden'); box._items = []; }
  refreshStationUI();
  toast(`已选${side === 'from' ? '上' : '下'}${stationWord(mode)}：${use.name}`);
}

function clearStation(side) {
  const mode = stationModeId();
  if (!mode) return;
  delete state.boardStations[side + ':' + mode];
  const box = $(`#${side}StationResults`);
  if (box) { box.classList.add('hidden'); box._items = []; }
  refreshStationUI();
}

function refreshStationUI() {
  rebuildAccess();
  renderTransport();          // 内部重绘站点面板与接驳栏
  ensureRoutes();
  if (state.step >= 4) { renderTimeline(); drawRoute(false); }
}

/* 接驳栏：出发点 ↔ 上车站、下车站 ↔ 住宿地，两侧都可换站 */
function renderAccessBar() {
  const el = $('#accessBar');
  const t = state.transport;
  if (!t) { el.classList.add('hidden'); return; }
  const mode = t.id;
  if (!['hsr', 'train', 'flight'].includes(mode)) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const p = accessPairs();
  const acc = state.access;
  const word = stationWord(mode);
  let h = `<div class="ab-head">📍 城际上下${word}（可搜索 / 切换）</div>`;
  h += accessLine('from', p.depPt, p.fromSt, acc && acc.from, mode);
  h += accessLine('to', p.toSt, p.destHub, acc && acc.to, mode);
  const src = (acc && acc.from && acc.from.src && acc.from.src !== '估算') ? acc.from.src : '';
  h += `<div class="ab-note">费用按出租车计价表（${TAXI_TARIFF.updated}）估算${src ? `，里程来自 ${src}` : ''}；换站后接驳里程会重算并缓存。</div>`;
  el.innerHTML = h;
}

function accessLine(side, a, b, acc, mode) {
  if (!b) {
    return `<div class="ab-line muted">${stationFallback(mode, stationCity(side).name)}</div>`;
  }
  const far = acc && acc.taxi.km > 30;
  const chips = stationCandidates(side).filter(s => s.lng != null && s.lat != null).slice(0, 10);
  const picked = selectedStation(side);
  let h = `<div class="ab-line">${side === 'from' ? `${esc(a.name)} → <b>${esc(b.name)}</b>` : `<b>${esc(a.name)}</b> → ${esc(b.name)}`}`;
  if (acc) {
    h += ` <span class="ab-opt">🚕 打车约 ${fmtDur(acc.taxi.min)} · ${fmtCost(acc.taxi.cost)}</span>`;
    h += far
      ? ' <span class="ab-opt muted">距离较远，建议打车 / 机场快线</span>'
      : ` <span class="ab-opt">🚇 公交地铁约 ${fmtDur(acc.transit.min)} · ${fmtCost(acc.transit.cost)}</span>`;
  }
  h += '</div>';
  if (chips.length > 1) {
    h += `<div class="ab-stations">换${stationWord(mode)}：` + chips.map(s =>
      `<button class="chip st-chip${picked && picked.name === s.name ? ' on' : ''}" data-side="${side}" data-station-pick="${s.name}">${esc(s.name)}</button>`).join('')
      + `<button class="chip st-chip" data-side="${side}" data-station-clear="1">自动</button></div>`;
  }
  return h;
}

/* ================= 市内通勤方式（示意估算） ================= */

function legOpts(km) {
  const o = [];
  if (km <= 2.5) o.push({ id: 'walk', icon: '🚶', name: '步行', min: km / 4.5 * 60 + 2, cost: 0 });
  if (km <= 6) o.push({ id: 'bike', icon: '🚲', name: '骑行', min: km / 12 * 60 + 4, cost: km > 1.2 ? 1.5 : 0 });
  o.push({ id: 'transit', icon: '🚇', name: '公交地铁', min: km / 17 * 60 + 12, cost: km > 10 ? 6 : 3 });
  o.push({ id: 'taxi', icon: '🚕', name: '打车', min: km / 26 * 60 + 6, cost: Math.max(12, Math.round(11 + 2.4 * km)) });
  return o;
}
const smartMode = km => km <= 1.2 ? 'walk' : km <= 4.5 ? 'bike' : km <= 15 ? 'transit' : 'taxi';
const legFastMin = km => legOpts(km)[legOpts(km).length - 1].min; // 最快方式（打车）分钟数

/* ================= 排序算法 ================= */

function routeCost(start, order, closed) {
  let c = 0, cur = start;
  for (const p of order) { c += roadKm(cur, p); cur = p; }
  if (closed && order.length) c += roadKm(cur, start);
  return c;
}

function optimalOrder(spots, start, closed) { // ≤8 个点枚举最优，更多用贪心 + 2-opt
  if (!spots.length) return [];
  if (spots.length <= 8) {
    let best = null, bc = Infinity;
    const perms = a => a.length <= 1 ? [a] :
      a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
    for (const p of perms(spots)) {
      const c = routeCost(start, p, closed);
      if (c < bc) { bc = c; best = p; }
    }
    return best.map(s => s.id);
  }
  let order = [], left = [...spots], cur = start;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((s, i) => { const dd = roadKm(cur, s); if (dd < bd) { bd = dd; bi = i; } });
    cur = left.splice(bi, 1)[0]; order.push(cur);
  }
  let base = routeCost(start, order, closed), improved = true;
  while (improved) {
    improved = false;
    outer:
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const c = routeCost(start, cand, closed);
        if (c < base - 1e-6) { order = cand; base = c; improved = true; break outer; }
      }
    }
  }
  return order.map(s => s.id);
}

function popularOrder(spots, start) { // 人气 / 距离 比，模拟"多数人的走法"
  const left = [...spots], out = [];
  let cur = start;
  while (left.length) {
    let bi = 0, bs = -1;
    left.forEach((s, i) => {
      const sc = s.satisfaction / (1 + roadKm(cur, s) / 3);
      if (sc > bs) { bs = sc; bi = i; }
    });
    cur = left.splice(bi, 1)[0]; out.push(cur);
  }
  return out.map(s => s.id);
}

/* ================= 分天引擎：聚类 + 容量平衡 ================= */

const geoKey = p => ({ x: p.lng * Math.cos(p.lat * Math.PI / 180), y: p.lat });
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

function dayLoad(daySpots, hub) { // 一天的分钟负载：游玩 + 全部接驳（按最快方式）
  let t = 0, cur = hub;
  for (const s of daySpots) { t += s.suggest_min + legFastMin(roadKm(cur, s)); cur = s; }
  if (daySpots.length) t += legFastMin(roadKm(cur, hub));
  return t;
}

function balanceClusters(clusters, wins, hub) {
  for (let guard = 0; guard < 30; guard++) {
    let oi = -1, ov = 0;
    clusters.forEach((c, i) => {
      const l = dayLoad(c, hub);
      if (l - wins[i].minutes > ov) { ov = l - wins[i].minutes; oi = i; }
    });
    if (oi < 0) break;
    const from = clusters[oi];
    let best = null;
    from.forEach((s, idx) => {
      clusters.forEach((target, ti) => {
        if (ti === oi) return;
        const nc = from.slice(0, idx).concat(from.slice(idx + 1));
        const nt = [...target, s];
        if (dayLoad(nt, hub) > wins[ti].minutes) return;
        const gain = dayLoad(from, hub) - dayLoad(nc, hub);
        if (!best || gain > best.gain) best = { idx, ti, gain };
      });
    });
    if (!best) break;
    clusters[best.ti].push(from.splice(best.idx, 1)[0]);
  }
}

function clusterAndBalance(spots, D, wins, hub) {
  const empty = [...Array(D)].map(() => []);
  if (!spots.length) return empty;
  if (spots.length <= D) { // 景点比天数少：近的排前面
    const sorted = spots.slice().sort((a, b) => roadKm(hub, a) - roadKm(hub, b));
    sorted.forEach((s, i) => empty[i].push(s));
    return empty;
  }
  const pts = spots.map(s => ({ ...geoKey(s), s }));
  const hubs = geoKey(hub);
  // 最远点初始化：第 1 个中心取离住宿地最近的点
  let centers = [pts.reduce((m, p) => dist2(p, hubs) < dist2(m, hubs) ? p : m, pts[0])];
  while (centers.length < D && centers.length < pts.length) {
    let best = null, bd = -1;
    pts.forEach(p => {
      const dmin = Math.min(...centers.map(c => dist2(p, c)));
      if (dmin > bd) { bd = dmin; best = p; }
    });
    centers.push(best);
  }
  let assign = [];
  for (let it = 0; it < 12; it++) {
    assign = pts.map(p => {
      let bi = 0, bd = Infinity;
      centers.forEach((c, i) => { const d = dist2(p, c); if (d < bd) { bd = d; bi = i; } });
      return bi;
    });
    centers = centers.map((c, i) => {
      const mine = pts.filter((_, j) => assign[j] === i);
      if (!mine.length) return c;
      return {
        x: mine.reduce((s, p) => s + p.x, 0) / mine.length,
        y: mine.reduce((s, p) => s + p.y, 0) / mine.length,
      };
    });
  }
  const clusters = [...Array(D)].map(() => []);
  pts.forEach((p, j) => clusters[assign[j]].push(p.s));
  // 离住宿地近的聚类排前面（第 1 天近、长途留给完整的一天）
  clusters.forEach((c, i) => {
    c._d = c.length ? dist2(centers[i], hubs) : 1e18;
  });
  clusters.sort((a, b) => a._d - b._d);
  balanceClusters(clusters, wins, hub);
  return clusters;
}

function planRecommended(spots) {
  const D = state.days.length, hub = hubOf(state.to), wins = dayWindows();
  return clusterAndBalance(spots, D, wins, hub).map(c => optimalOrder(c, hub, true));
}

function planPopular(spots) { // 人气链路按容量顺序切段
  const D = state.days.length, hub = hubOf(state.to), wins = dayWindows();
  const ordered = popularOrder(spots, hub).map(id => POIMAP[id]);
  const days = [...Array(D)].map(() => []);
  const loads = [...Array(D)].map(() => 0);
  let di = 0;
  ordered.forEach(s => {
    while (di < D - 1) {
      const last = days[di][days[di].length - 1] || hub;
      if (loads[di] + legFastMin(roadKm(last, s)) + s.suggest_min <= wins[di].minutes) break;
      di++;
    }
    const last = days[di][days[di].length - 1] || hub;
    loads[di] += legFastMin(roadKm(last, s)) + s.suggest_min;
    days[di].push(s);
  });
  return days.map(d => d.map(s => s.id));
}

function computeSchemes() {
  const spots = state.selected.map(id => POIMAP[id]);
  state.orders.recommended = planRecommended(spots);
  state.orders.popular = planPopular(spots);
  state.orders.custom = state.orders.recommended.map(d => [...d]);
}

/* ================= 方案渲染 ================= */

function getOrder() { return state.orders[state.scheme] || []; }

function resetFastestButton() {
  $$('.preset-row [data-preset="smart"]').forEach(b => {
    b.disabled = false;
    b.textContent = '⚡ 最快组合';
    delete b.dataset.fastestRun;
  });
}

function initModes() {
  fastestToken++;  // 方案 / 顺序变了，在途的最快组合结果作废
  resetFastestButton();
  const hub = hubOf(state.to);
  state.modes = [];
  getOrder().forEach(dayIds => {
    if (!dayIds.length) return; // 空天（自由活动）不占路段
    const seq = [hub, ...dayIds.map(id => POIMAP[id]), hub];
    for (let k = 1; k < seq.length; k++) {
      state.modes.push(smartMode(roadKm(seq[k - 1], seq[k])));
    }
  });
}

function computeTotals() {
  const order = getOrder();
  const hub = hubOf(state.to);
  const wins = dayWindows();
  let legIdx = 0;
  const perDay = order.map((dayIds, di) => {
    if (!dayIds.length) return { moveMin: 0, moveCost: 0, km: 0, playMin: 0, warn: 0 };
    const seq = [hub, ...dayIds.map(id => POIMAP[id]), hub];
    let moveMin = 0, moveCost = 0, km = 0, playMin = 0;
    for (let k = 1; k < seq.length; k++) {
      const d = roadKm(seq[k - 1], seq[k]);
      const opts = legOptsFor(d, seq[k - 1], seq[k]);
      km += (routeEst.get(pairKey(seq[k - 1], seq[k])) || {}).taxi?.km || d;
      const o = opts.find(x => x.id === state.modes[legIdx]) || opts[opts.length - 1];
      moveMin += o.min; moveCost += o.cost;
      legIdx++;
    }
    dayIds.forEach(id => { playMin += POIMAP[id].suggest_min; });
    return {
      moveMin, moveCost, km, playMin,
      warn: Math.max(0, moveMin + playMin - wins[di].minutes),
    };
  });
  const sum = key => perDay.reduce((s, d) => s + d[key], 0);
  let playMin = 0, ticket = 0;
  order.flat().forEach(id => { playMin += POIMAP[id].suggest_min; ticket += POIMAP[id].ticket; });
  const ic = state.transport || { min: 0, cost: 0 };
  const acc = accessTotals();
  return {
    perDay,
    moveMin: sum('moveMin'), moveCost: sum('moveCost'), km: sum('km'),
    playMin, ticket: state.withTicket ? ticket : 0,
    accessMin: acc.min, accessCost: acc.cost,
    totalMin: ic.min + acc.min + sum('moveMin') + playMin,
    totalCost: ic.cost + acc.cost + sum('moveCost') + (state.withTicket ? ticket : 0),
  };
}

function schemeMetaText() {
  const t = computeTotals();
  const n = getOrder().flat().length;
  const alg = state.scheme === 'recommended'
    ? `地理聚类分 ${state.days.length} 天 + 每天最优排序${n <= 8 ? '（全排列枚举）' : '（贪心 + 2-opt）'}`
    : state.scheme === 'popular' ? '按「人气 ÷ 就近」排链路后按时间窗切段' : '手动调整：当天内 ↑↓ 排序，⇤⇥ 跨天挪动';
  return `${alg} · 市内通勤 ${fmtDur(t.moveMin)} / ${fmtKm(t.km)} · 游玩 ${fmtDur(t.playMin)}`;
}

function renderTripMeta() {
  const ic = state.transport;
  let s = state.days.length > 1
    ? `🗓 ${fmtDateCN(state.days[0])} — ${fmtDateCN(state.days[state.days.length - 1])} · 共 ${state.days.length} 天`
    : `🗓 ${fmtDateCN(state.days[0])} · 当天往返`;
  if (ic) {
    const dep = toMin(state.departTime);
    if (dep != null) {
      const a = arrivalInfo();
      const arrTxt = a.arriveMin != null
        ? `${a.spill > 0 ? '+' + a.spill + ' 天 ' : ''}${fmtHM(a.arriveMin)} 抵达酒店`
        : '';
      s += ` ｜ ${ic.icon} ${fmtDateCN(state.days[0])} ${fmtHM(dep)} 出发 · ${fmtDur(ic.min)} · ${arrTxt}`;
      if (a.spill > 0) s += '（去程跨天，第 1 天按晚间自由活动安排）';
    } else {
      s += ` ｜ ${ic.icon} ${fmtDur(ic.min)} · ${fmtCost(ic.cost)}`;
    }
  }
  if (state.returnTime) s += ` ｜ 返程 ${state.returnTime}`;
  $('#tripMeta').textContent = s;
}

/* 城际衔接：出发点 → 机场/火车站 → 目的地枢纽 → 酒店 */
function intercityPlanLegs() {
  const tr = state.transport;
  const p = accessPairs();
  if (!tr || !p) return null;
  const acc = state.access || {};
  const stationMode = ['hsr', 'train', 'flight'].includes(tr.id);
  const accessLeg = (key, a, b, est) => {
    if (!est || !a || !b) return null;
    return {
      kind: 'access', key, icon: '🚕', from: a, to: b,
      min: est.taxi.min, cost: est.taxi.cost,
      altMin: est.transit.min, altCost: est.transit.cost,
      far: (est.taxi.km || 0) > 30,
    };
  };
  const out = [];
  if (stationMode) {
    const a = accessLeg('from', p.depPt, p.fromSt, acc.from);
    if (a) out.push(a);
  }
  out.push({
    kind: 'ic', icon: tr.icon, name: tr.name,
    from: p.fromSt || p.depPt, to: p.toSt || p.destHub,
    min: tr.min, cost: tr.cost, station: stationMode,
  });
  if (stationMode) {
    const b = accessLeg('to', p.toSt, p.destHub, acc.to);
    if (b) out.push(b);
  }
  const back = [];
  if (state.returnTime) {
    if (stationMode) {
      const a = accessLeg('backfrom', p.destHub, p.toSt, acc.to);
      if (a) back.push(a);
    }
    back.push({
      kind: 'ic', icon: tr.icon, name: tr.name,
      from: p.toSt || p.destHub, to: p.fromSt || p.depPt,
      min: tr.min, cost: tr.cost, station: stationMode,
    });
    if (stationMode) {
      const b = accessLeg('backto', p.fromSt, p.depPt, acc.from);
      if (b) back.push(b);
    }
  }
  return { tr, p, out, back };
}

function icLegHTML(l) {
  let meta;
  if (l.kind === 'ic') {
    meta = `${l.name}约 ${fmtDur(l.min)} · ${fmtCost(l.cost)}`
      + (l.station
        ? ' <i>· 具体航班 / 车次与票价以票务平台为准</i>'
        : ' <i>· 门到门按里程估算</i>');
  } else {
    meta = `🚕 打车约 ${fmtDur(l.min)} · ${fmtCost(l.cost)}`
      + ` <i>｜ 🚇 公交地铁约 ${fmtDur(l.altMin)} · ${fmtCost(l.altCost)}</i>`;
    if (l.far) meta += ' <i>｜ 距离较远，建议打车 / 机场快线</i>';
  }
  const nav = l.key
    ? `<button class="mini navic" data-navic="${l.key}" title="在百度地图导航这一段">🧭</button>` : '';
  return `<div class="ic-leg${l.kind === 'ic' ? ' main' : ''}">`
    + `<span class="ic-ico">${l.icon}</span>`
    + `<div class="ic-body"><div class="ic-line"><b>${esc(l.from.name)}</b>`
    + `<span class="ic-arrow">→</span><b>${esc(l.to.name)}</b></div>`
    + `<div class="ic-meta">${meta}</div></div>${nav}</div>`;
}

function icLegEndpoints(key) {
  const p = accessPairs();
  if (!p) return null;
  if (key === 'from') return [p.depPt, p.fromSt, state.from.name];
  if (key === 'to') return [p.toSt, p.destHub, state.to.name];
  if (key === 'backfrom') return [p.destHub, p.toSt, state.to.name];
  if (key === 'backto') return [p.fromSt, p.depPt, state.from.name];
  return null;
}

function intercityPlanHTML() {
  const plan = intercityPlanLegs();
  if (!plan) return '';
  const { tr, p, out, back } = plan;
  const outMin = out.reduce((s, l) => s + (l.min || 0), 0);
  const outCost = out.reduce((s, l) => s + (l.cost || 0), 0);
  const dep = toMin(state.departTime);
  let outTime = `门到门约 ${fmtDur(outMin)} · ${fmtCost(outCost)}`;
  if (dep != null) {
    const total = dep + outMin, spill = Math.floor(total / 1440);
    outTime = `${state.departTime} 出发 · 预计 ${spill ? `+${spill} 天 ` : ''}${fmtHM(total)} 到酒店`;
  }
  let backHTML = '';
  if (back.length) {
    const backMin = back.reduce((s, l) => s + (l.min || 0), 0);
    const backCost = back.reduce((s, l) => s + (l.cost || 0), 0);
    const ret = toMin(state.returnTime);
    let backTime = `门到门约 ${fmtDur(backMin)} · ${fmtCost(backCost)}`;
    if (ret != null) {
      const total = ret + backMin, spill = Math.floor(total / 1440);
      backTime = `酒店 ${state.returnTime} 出发 · 预计 ${spill ? `+${spill} 天 ` : ''}${fmtHM(total)} 回到 ${esc(p.depPt.name)}`;
    }
    backHTML = `<div class="ic-block"><div class="ic-block-title">`
      + `<b>返程</b><span class="ic-time">${backTime}</span></div>`
      + back.map(icLegHTML).join('') + '</div>';
  }
  return `<div class="ic-plan">
    <div class="ic-plan-head">
      <span class="ic-plan-title">${tr.icon} 城际衔接 · ${esc(state.from.name)} → ${esc(state.to.name)}</span>
      <span class="ic-plan-sub">去程 ${fmtDur(outMin)} · ${fmtCost(outCost)}</span>
    </div>
    <div class="ic-block">
      <div class="ic-block-title"><b>去程${state.days.length ? ` · ${fmtDateCN(state.days[0])}` : ''}</b>`
      + `<span class="ic-time">${outTime}</span></div>
      ${out.map(icLegHTML).join('')}
    </div>
    ${backHTML}
    <div class="ic-foot">接驳为出租车 / 公交地铁估算；城际为门到门估算，具体航班、车次与票价以票务平台为准。</div>
  </div>`;
}

function renderLegend() {
  const el = $('#legend');
  if (!el) return;
  const order = getOrder();
  const dayCount = Math.max(1, order.filter(a => a.length).length);
  let days = '';
  for (let i = 0; i < dayCount; i++) {
    days += `<span class="lg-day"><i class="lg-dot" style="background:${dayColor(i)}"></i>第 ${i + 1} 天</span>`;
  }
  el.innerHTML =
    `<span class="lg-group"><span class="lg-title">线的颜色 = 第几天</span>${days}</span>`
    + '<span class="lg-group"><span class="lg-title">路段圆标 = 怎么走</span>'
    + '<span class="lg-item"><i class="mode-badge mb-walk">步</i>步行</span>'
    + '<span class="lg-item"><i class="mode-badge mb-bike">骑</i>骑行</span>'
    + '<span class="lg-item"><i class="mode-badge mb-transit">交</i>公交 / 地铁</span>'
    + '<span class="lg-item"><i class="mode-badge mb-taxi">打</i>打车</span></span>'
    + '<span class="lg-group"><span class="lg-title">标记</span>'
    + '<span class="lg-item"><i class="lg-pin">🏨</i>住宿 / 出发点</span>'
    + '<span class="lg-item"><i class="lg-pin">1·2</i>第 1 天第 2 站</span></span>';
}

function renderTimeline() {
  const order = getOrder();
  const hub = hubOf(state.to);
  const t = computeTotals();
  const custom = state.scheme === 'custom';
  let legIdx = 0, h = intercityPlanHTML();
  order.forEach((dayIds, di) => {
    const pd = t.perDay[di];
    h += `<div class="day-block" style="--day-c:${dayColor(di)}"><div class="day-head">`
      + `<span class="d-dot" style="background:${dayColor(di)}"></span><span class="d-num">第 ${di + 1} 天</span>`
      + `<span class="d-date">${fmtDateCN(state.days[di])}</span>`
      + `<span class="d-sub">通勤 ${fmtDur(pd.moveMin)} · 游玩 ${fmtDur(pd.playMin)}</span>`
      + (pd.warn ? `<span class="d-warn">⚠ 超出时间窗约 ${fmtDur(pd.warn)}</span>` : '')
      + `</div>`
      + `<div class="day-body">`;
    if (!dayIds.length) {
      h += `<div class="t-rest">🌿 这一天自由活动，可在「自定义安排」里把景点挪过来</div></div></div>`;
      return;
    }
    const seq = [hub, ...dayIds.map(id => POIMAP[id]), hub];
    seq.forEach((p, k) => {
      if (k > 0) {
        const km = roadKm(seq[k - 1], p);
        const opts = legOptsFor(km, seq[k - 1], p);
        const chosenMode = state.modes[legIdx];
        const comp = compositionHTML(routeGeo.get(geoKeyOf(seq[k - 1], p, chosenMode)));
        h += `<div class="tleg"><div class="lbl">第 ${di + 1} 天 · 段 ${k} · 约 ${fmtKm(km)}</div><div class="modes">`
          + opts.map(o => `<button class="chip c-${o.id}${chosenMode === o.id ? ' on' : ''}" data-leg="${legIdx}" data-mode="${o.id}">`
            + `${o.icon} ${o.name} ${fmtDur(o.min)}${o.cost ? ` <span class="c-cost">¥${Math.round(o.cost)}</span>` : ''}</button>`).join('')
          + `<button class="mini navleg" data-leg="${legIdx}">🧭 导航</button></div>${comp}</div>`;
        legIdx++;
      }
      if (p.isHub) {
        h += `<div class="tnode hub"><span class="dot"></span><div class="t-title">
          <span class="t-name">🏨 ${p.name}</span>
          <span class="t-sub">${k === 0 ? '当天从这里出发' : '返回住宿地'}</span></div></div>`;
      } else {
        const i = k - 1;
        const mv = custom
          ? `${i > 0 ? `<button class="mv" data-mv="up" data-day="${di}" data-i="${i}" title="当天内前移">↑</button>` : ''}`
            + `${i < dayIds.length - 1 ? `<button class="mv" data-mv="down" data-day="${di}" data-i="${i}" title="当天内后移">↓</button>` : ''}`
            + `${di > 0 ? `<button class="mv" data-daymove="prev" data-day="${di}" data-i="${i}" title="挪到前一天">⇤</button>` : ''}`
            + `${di < order.length - 1 ? `<button class="mv" data-daymove="next" data-day="${di}" data-i="${i}" title="挪到后一天">⇥</button>` : ''}`
          : '';
        h += `<div class="tnode"><span class="dot"></span><div class="t-title">
          <span class="t-num">${di + 1}.${k}</span><span class="t-name">${p.name}</span>
          <span class="t-sub">游玩约 ${fmtDur(p.suggest_min)} · ${p.ticket ? '门票 ¥' + p.ticket : '免费'}</span>
          ${mv}<button class="mini navspot" data-leg="${legIdx - 1}">🧭</button></div></div>`;
      }
    });
    h += '</div></div>';
  });
  $('#timeline').innerHTML = h;
  $('#schemeMeta').textContent = schemeMetaText();
  renderTripMeta();
  renderLegend();
  ensureRoutes();

  $('#totals').innerHTML = `
    ${ic2Row()}
    <span class="t">市内通勤 <b>${fmtDur(t.moveMin)}</b> · ${fmtCost(t.moveCost)}</span>
    <span class="t">游玩 <b>${fmtDur(t.playMin)}</b></span>
    ${t.ticket ? `<span class="t">门票 ${fmtCost(t.ticket)}</span>` : ''}
    <span class="t total">全程约 <b>${fmtDur(t.totalMin)}</b> · 合计 ${fmtCost(t.totalCost)}</span>`;
}
function ic2Row() {
  const ic = state.transport;
  const acc = accessTotals();
  if (!ic) return '';
  let s = `<span class="t">城际 ${ic.icon} ${fmtDur(ic.min)} · ${fmtCost(ic.cost)}</span>`;
  if (acc.min) {
    const src = state.access && (state.access.from || state.access.to);
    s += `<span class="t">接驳 ${fmtDur(acc.min)} · ${fmtCost(acc.cost)}<i class="est" title="${src ? src.src : ''}估算：出发点↔车站按出租车计价表</i></span>`;
  }
  return s;
}

/* ================= 景点选择 ================= */

function tierLabel(t) { return TIERS[t] ? TIERS[t].label : ''; }

const freeSpotState = {};  // city -> {loading, failedAt, error}

function showFreeSpotLoading(city) {
  $('#tierFilter').classList.add('hidden');
  $('#selInfo').textContent = '正在加载免费景点数据…';
  $('#spotGrid').innerHTML = `<div class="notice">
    <h3>🔎 正在从 OpenStreetMap 获取「${esc(city)}」的景点</h3>
    <p>免费开放数据，不占百度配额；首次获取后本机缓存 7 天。</p>
  </div>`;
}

function loadFreeSpots(city) {
  const entry = freeSpotState[city] = freeSpotState[city] || {};
  if (entry.loading) return;
  if (entry.failedAt && Date.now() - entry.failedAt < 60000) {
    return renderNotCovered(true, entry.error);
  }
  entry.loading = true;
  entry.error = '';
  showFreeSpotLoading(city);
  FREE.attractions(city, CITYMAP[city] || state.to, 30).then(places => {
    entry.loading = false;
    if (!places.length) {
      entry.failedAt = Date.now();
      entry.error = FREE.lastError || '该城市周边没有查到可用景点';
      if (state.to.name === city && state.step === 3) renderNotCovered(true, entry.error);
      return;
    }
    const spots = places.map(p => ({
      id: p.id || `osm-${city}-${p.name}`,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      tier: p.tier || 'explore',
      ticket: Number(p.ticket) || 0,
      suggest_min: Number(p.suggest_min) || 90,
      satisfaction: Number(p.satisfaction) || 0.6,
      note: p.note || 'OpenStreetMap',
      source: p.source || 'OpenStreetMap',
    }));
    POIS[city] = spots;
    spots.forEach(p => { POIMAP[p.id] = p; });
    entry.list = spots;
    entry.failedAt = 0;
    if (state.to.name === city && state.step === 3) {
      renderSpots();
      showSpots(true);
      toast(`已从 OpenStreetMap 获取 ${spots.length} 个景点（免费数据，仅供参考）`);
    }
  }).catch(err => {
    entry.loading = false;
    entry.failedAt = Date.now();
    entry.error = (err && err.message) || FREE.lastError || '免费数据源请求失败';
    if (state.to.name === city && state.step === 3) renderNotCovered(true, entry.error);
  });
}

function renderSpots() {
  const list = POIS[state.to.name] || [];
  $('#destName').textContent = state.to.name;

  if (!list.length) return loadFreeSpots(state.to.name);

  renderTierFilter(list);
  const shown = state.spotTier === 'all' ? list : list.filter(p => p.tier === state.spotTier);
  const hub = hubOf(state.to);
  if (!shown.length) {
    $('#spotGrid').innerHTML = '<div class="notice"><p>该分类下暂无景点，换一个分类看看。</p></div>';
    updateSelInfo();
    return;
  }
  $('#spotGrid').innerHTML = shown.map(p => {
    const on = state.selected.includes(p.id);
    const km = hav(hub, p);
    return `<button class="spot${on ? ' on' : ''}" data-id="${p.id}">
      <span class="tick">${on ? '✓' : ''}</span>
      <span class="tier t-${p.tier}">${tierLabel(p.tier)}</span>
      <span class="nm">${p.name}</span>
      <span class="meta"><span>${p.ticket ? '¥' + p.ticket : '免费'}</span><span>约 ${fmtDur(p.suggest_min)}</span><span>${fmtKm(km)}</span></span>
      <span class="bar"><i style="width:${Math.round(p.satisfaction * 100)}%"></i></span>
    </button>`;
  }).join('');
  updateSelInfo();
}

function renderTierFilter(list) {
  const counts = { all: list.length };
  TIERS_ALL.forEach(t => { counts[t] = list.filter(p => p.tier === t).length; });
  const cells = [['all', '全部']].concat(TIERS_ALL.map(t => [t, tierLabel(t)]));
  $('#tierFilter').classList.remove('hidden');
  $('#tierFilter').innerHTML = cells.map(([t, label]) => {
    const off = t !== 'all' && !counts[t];
    return `<button data-tier="${t}" ${off ? 'disabled' : ''} class="${state.spotTier === t ? 'on' : ''}">${label}${counts[t] ? ` <i>${counts[t]}</i>` : ''}</button>`;
  }).join('');
}

function renderNotCovered(freeFailed, error) {
  $('#tierFilter').classList.add('hidden');
  $('#selInfo').textContent = '已选 0 个';
  const hub = hubOf(state.to);
  const near = CURATED_CITIES
    .map(c => ({ c, km: hav(state.to, c) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 3);
  const failHTML = freeFailed
    ? `<p class="muted">OpenStreetMap 免费数据源暂时不可用${error ? `：${esc(error)}` : ''}。
        <button type="button" class="ghost-btn sm" data-free-retry="1">重试免费数据源</button></p>`
    : `<p class="muted">可点击下方按钮从 OpenStreetMap 免费获取周边景点（不占百度配额）。</p>
       <p><button type="button" class="ghost-btn sm" data-free-retry="1">🔎 从 OpenStreetMap 获取景点</button></p>`;
  $('#spotGrid').innerHTML = `
    <div class="notice">
      <h3>🧭 「${state.to.name}」暂无内置景点数据</h3>
      <p>本原型深度收录了 ${CURATED_CITIES.length} 个城市（四级分类：热门 / 性价比 / 冷门 / 待探索）；
      其余地级市可正常查询交通，也可以自动从免费开放数据补充景点。</p>
      ${failHTML}
      <p class="near-label">附近已收录的城市：</p>
      <div class="near-list">
        ${near.map(n => `<button class="ghost-btn" data-goto-city="${n.c.name}">${n.c.name} · ${Math.round(n.km)} km</button>`).join('')}
      </div>
    </div>`;
  if (map && gSpots) {
    MAPAPI.clear(gSpots);
    Object.keys(spotMarkers).forEach(k => delete spotMarkers[k]);
    MAPAPI.dot(gSpots, state.to, {
      fill: '#a8671c', px: 8,
      popup: `<b>${state.to.name}</b><br>市中心（示意）`,
    });
    fitPts([state.to]);
  }
}

function updateSelInfo() {
  const n = state.selected.length;
  const play = state.selected.reduce((s, id) => s + POIMAP[id].suggest_min, 0);
  $('#selInfo').textContent = `已选 ${n} 个 · 游玩约 ${fmtDur(play)}` + (n > 8 ? ' · 偏多，正好分几天安排' : '');
}

function toggleSpot(id) {
  const i = state.selected.indexOf(id);
  if (i >= 0) state.selected.splice(i, 1); else state.selected.push(id);
  renderSpots();
  refreshSpotMarkers();
}

/* ================= 地图 ================= */

let map = null, gInter, gSpots, gRoute;
const MODE_STYLE = {
  // 线宽 + 虚线段 + 路段中点圆标：三种线索叠加，避免只靠虚线区分
  // （百度 GL / 高德 JS API 只认 solid/dashed，自定义虚线样式在它们上面会退化成同一种）
  walk: { c: '#3d8b37', d: '2,7', w: 3, icon: '步', cls: 'mb-walk' },
  bike: { c: '#c07b12', d: '7,7', w: 4, icon: '骑', cls: 'mb-bike' },
  transit: { c: '#2f6bb0', d: null, w: 5, icon: '交', cls: 'mb-transit' },
  taxi: { c: '#6d4fa1', d: '11,6', w: 4, icon: '打', cls: 'mb-taxi' },
};

// 一天一个颜色：多天路线叠在同一张地图上时用颜色区分，线型仍表示交通方式
const DAY_COLORS = [
  '#d64545', '#2f6bb0', '#2f8f5b', '#c07b12', '#7a4fb3', '#0f8b8d',
  '#c2457f', '#8a6d1d', '#4b6cb7', '#b35c1e', '#5c8a3a', '#8e3b8e',
  '#287f7a', '#a33c5e', '#3d6a99',
];
const dayColor = di => DAY_COLORS[di % DAY_COLORS.length];
const NAV_MODE = { walk: 'walking', bike: 'riding', transit: 'transit', taxi: 'driving' };

/* 公交路线的换乘组成（步行 → 地铁/公交 → 步行） */
function segLabel(s) {
  if (s.mode === 'transit') {
    const icon = /地铁|轨道/.test(s.name || '') ? '🚇' : '🚌';
    return `${icon} ${esc(s.name || '公交')}${s.stops ? ` · ${s.stops}站` : ''}`;
  }
  return `🚶 ${Math.max(30, Math.round((s.km || 0) * 1000))}m`;
}
function compositionHTML(geo, cls) {
  const segs = geo && geo.segments;
  if (!segs || segs.length < 2) return '';
  return `<span class="${cls || 'tleg-detail'}">` + segs.map((s, i) =>
    (i ? '<span class="seg-arrow">→</span>' : '')
    + `<span class="seg ${s.mode === 'transit' ? 'transit' : 'walk'}">${segLabel(s)}</span>`).join('') + '</span>';
}

/* ================= 地图抽象层：Leaflet(OSM) / 百度 JS API GL 双后端 =================
 * 展示层后端选择：配置了浏览器端 AK 且 JS API GL 加载成功 → 百度地图；否则 OSM。
 * 百度瓦片是 BD-09 自有投影无法直接叠在 Leaflet 上，故 GL 后端整体替换而非叠瓦片。
 * 上层代码（showIntercity / showSpots / drawRoute …）只调 MAPAPI，不感知后端。
 */
let MAP_BACKEND = 'leaflet';    // 后端原生对象 map 在 _init* 里赋值
const spotMarkers = {};         // 景点 id -> 圆点句柄（双后端通用的改色句柄）

const MAPAPI = {
  async pickBackend() {
    await MAPS.probe();  // 先取本地配置：环境变量里的浏览器端 AK 在这里生效
    if (MAPS.provider === 'amap') {
      if (AMAP.key && await AMAP.load()) return 'amap';
      return 'leaflet';
    }
    if (BAIDU.browserKey && location.protocol.startsWith('http')) {
      if (await BAIDU.loadGL()) return 'baidu';
    }
    // 自动模式：没配百度浏览器端 AK、但有高德 key 时，用高德 JS API 做展示层
    if (!BAIDU.browserKey && AMAP.key) {
      if (await AMAP.load()) return 'amap';
    }
    return 'leaflet';
  },

  init(backend) {
    MAP_BACKEND = backend;
    if (backend === 'baidu') return this._initBaidu();
    if (backend === 'amap') return this._initAmap();
    return this._initLeaflet();
  },

  fit(pts) {
    if (!map || !pts.length) return;
    if (MAP_BACKEND === 'amap') {
      const lngs = pts.map(p => p.lng), lats = pts.map(p => p.lat);
      map.setBounds(
        new AMap.Bounds([Math.min(...lngs), Math.min(...lats)],
                        [Math.max(...lngs), Math.max(...lats)]),
        false, [42, 42, 42, 42],
      );
    } else if (MAP_BACKEND === 'baidu') {
      map.setViewport(pts.map(p => BAIDU.bd(p)), { margins: [42, 42, 42, 42] });
    } else {
      map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])), { padding: [42, 42] });
    }
  },

  clear(g) { g.clear(); },

  // 两点连线（含弹窗）
  line(g, a, b, { color, weight = 4, dash = null, opacity = 0.85, popup }) {
    if (MAP_BACKEND === 'amap') {
      const pl = new AMap.Polyline({
        path: [[a.lng, a.lat], [b.lng, b.lat]],
        strokeColor: color, strokeWeight: weight, strokeOpacity: opacity,
        strokeStyle: dash ? 'dashed' : 'solid', lineJoin: 'round',
      });
      if (popup) pl.on('click', () => {
        new AMap.InfoWindow({ content: popup, offset: new AMap.Pixel(0, -10) })
          .open(map, [a.lng, a.lat]);
      });
      map.add(pl); g.push(pl);
    } else if (MAP_BACKEND === 'baidu') {
      const pl = new BMapGL.Polyline([BAIDU.bd(a), BAIDU.bd(b)], {
        strokeColor: color, strokeWeight: weight, strokeOpacity: opacity,
        strokeStyle: dash ? 'dashed' : 'solid',
      });
      if (popup) pl.addEventListener('click', () => {
        map.openInfoWindow(new BMapGL.InfoWindow(popup, { width: 260 }), BAIDU.bd(a));
      });
      map.addOverlay(pl); g.push(pl);
    } else {
      const pl = L.polyline([[a.lat, a.lng], [b.lat, b.lng]],
        { color, weight, opacity, dashArray: dash || null })
        .bindPopup(popup || '').addTo(g);
    }
  },

  // 实际道路折线：pts 为 [[lng,lat],...]（GCJ-02），直接来自百度 direction/api
  path(g, pts, { color, weight = 4, dash = null, opacity = 0.9, popup } = {}) {
    if (!pts || pts.length < 2) return;
    if (MAP_BACKEND === 'amap') {
      const pl = new AMap.Polyline({
        path: pts.map(([lng, lat]) => [lng, lat]),
        strokeColor: color, strokeWeight: weight, strokeOpacity: opacity,
        strokeStyle: dash ? 'dashed' : 'solid', lineJoin: 'round',
      });
      if (popup) pl.on('click', () => {
        const mid = pts[Math.floor(pts.length / 2)];
        new AMap.InfoWindow({ content: popup, offset: new AMap.Pixel(0, -10) })
          .open(map, [mid[0], mid[1]]);
      });
      map.add(pl); g.push(pl);
      return;
    }
    if (MAP_BACKEND === 'baidu') {
      const line = new BMapGL.Polyline(pts.map(([lng, lat]) => BAIDU.bd({ lng, lat })), {
        strokeColor: color, strokeWeight: weight, strokeOpacity: opacity,
        strokeStyle: dash ? 'dashed' : 'solid',
      });
      if (popup) line.addEventListener('click', () => {
        const mid = pts[Math.floor(pts.length / 2)];
        map.openInfoWindow(new BMapGL.InfoWindow(popup, { width: 260 }),
          BAIDU.bd({ lng: mid[0], lat: mid[1] }));
      });
      map.addOverlay(line); g.push(line);
    } else {
      const pl = L.polyline(pts.map(([lng, lat]) => [lat, lng]),
        { color, weight, opacity, dashArray: dash || null })
        .bindPopup(popup || '').addTo(g);
      pl._routePath = pts;
    }
  },

  // HTML 图钉（复用 .pin 样式）
  pin(g, pt, { html, w, h, popup, z = 0 }) {
    if (MAP_BACKEND === 'amap') {
      const mk = new AMap.Marker({
        position: [pt.lng, pt.lat], content: html, anchor: 'top-left',
        offset: new AMap.Pixel(-w / 2, -h / 2), zIndex: 500 + z,
      });
      if (popup) mk.on('click', () => {
        new AMap.InfoWindow({ content: popup, offset: new AMap.Pixel(0, -10) })
          .open(map, [pt.lng, pt.lat]);
      });
      map.add(mk); g.push(mk);
    } else if (MAP_BACKEND === 'baidu') {
      const label = new BMapGL.Label(html, { position: BAIDU.bd(pt), offset: new BMapGL.Size(-w / 2, -h / 2) });
      if (label.domElement) {
        label.domElement.style.background = 'none';
        label.domElement.style.border = 'none';
        label.domElement.style.zIndex = String(500 + z);
      }
      const open = () => map.openInfoWindow(new BMapGL.InfoWindow(popup || '', { width: 260 }), BAIDU.bd(pt));
      if (popup) {
        label.addEventListener('click', open);
        if (label.domElement) label.domElement.style.cursor = 'pointer';
      }
      map.addOverlay(label); g.push(label);
    } else {
      const mk = L.marker([pt.lat, pt.lng], {
        icon: L.divIcon({ className: 'pin-wrap', html, iconSize: [w, h], iconAnchor: [w / 2, h / 2] }),
        zIndexOffset: z,
      }).addTo(g);
      if (popup) mk.bindPopup(popup);
    }
  },

  // 景点圆点（id 供勾选联动改色）
  dot(g, pt, { fill, px = 7, popup, onClick }) {
    let handle;
    if (MAP_BACKEND === 'amap') {
      const c = new AMap.CircleMarker({
        center: [pt.lng, pt.lat], radius: px,
        strokeColor: '#fff', strokeWeight: 2, fillColor: fill, fillOpacity: 0.95, zIndex: 120,
      });
      if (popup) c.on('click', () => {
        new AMap.InfoWindow({ content: popup, offset: new AMap.Pixel(0, -10) })
          .open(map, [pt.lng, pt.lat]);
      });
      if (onClick) c.on('click', onClick);
      map.add(c); g.push(c);
      handle = c;
    } else if (MAP_BACKEND === 'baidu') {
      const c = new BMapGL.Circle(BAIDU.bd(pt), 130, {
        strokeColor: '#fff', strokeWeight: 2, fillColor: fill, fillOpacity: 0.95,
      });
      if (popup) c.addEventListener('click', () => {
        map.openInfoWindow(new BMapGL.InfoWindow(popup, { width: 260 }), BAIDU.bd(pt));
      });
      if (onClick) c.addEventListener('click', onClick);
      map.addOverlay(c); g.push(c);
      handle = c;
    } else {
      const m = L.circleMarker([pt.lat, pt.lng], {
        radius: px, color: '#fff', weight: 2, fillColor: fill, fillOpacity: 0.95,
      }).addTo(g);
      if (popup) m.bindPopup(popup);
      if (onClick) m.on('click', onClick);
      handle = m;
    }
    return handle;
  },

  setDotFill(handle, fill) {
    if (MAP_BACKEND === 'baidu') handle.setFillColor(fill);
    else if (MAP_BACKEND === 'amap') {
      try { handle.setOptions({ fillColor: fill }); } catch (e) { /* 老版本没有 setOptions */ }
    } else handle.setStyle({ fillColor: fill });
  },

  _initLeaflet() {
    const m = L.map('map', { zoomControl: true });
    m.attributionControl.setPrefix(false);
    const mk = () => {
      const group = L.layerGroup().addTo(m);
      group.clear = () => group.clearLayers();
      return group;
    };
    // 用户在工具栏里显式选了高德：底图直接用高德栅格瓦片（GCJ-02，与页面坐标天然对齐）
    if (typeof MAPS !== 'undefined' && MAPS.provider === 'amap') {
      L.tileLayer('/api/tiles/{z}/{x}/{y}.png', {
        maxZoom: 18, attribution: '© 高德地图',
      }).addTo(m);
      map = m;
      return { inter: mk(), spots: mk(), route: mk() };
    }
    // 默认：优先 OSM；连续失败（国内网络经常连不上 tile.openstreetmap.org）时
    // 自动切到高德栅格瓦片。
    let tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(m);
    let tileErrs = 0, tileLoads = 0, swapped = false;
    const useAmap = () => {  // 高德瓦片与页面 GCJ-02 坐标天然对齐
      if (swapped) return;
      swapped = true;
      m.removeLayer(tiles);
      // 走本地服务代取瓦片：客户端网络受限时也能显示（serve.py 内存缓存）
      tiles = L.tileLayer('/api/tiles/{z}/{x}/{y}.png', {
        maxZoom: 18, attribution: '© 高德地图',
      }).addTo(m);
    };
    tiles.on('tileload', () => { tileLoads++; });
    tiles.on('tileerror', () => { if (++tileErrs >= 4) useAmap(); });
    // 有些网络对 OSM 不是报错而是长时间挂起：1.5s 内一张瓦片都没成功就直接换源
    setTimeout(() => { if (!swapped && tileLoads === 0) useAmap(); }, 1500);
    map = m;
    return { inter: mk(), spots: mk(), route: mk() };
  },

  _initBaidu() {
    const m = new BMapGL.Map('map', { enableMapClick: false });
    m.centerAndZoom(new BMapGL.Point(112.0, 32.8), 5);
    m.enableScrollWheelZoom(true);
    const mk = () => { const arr = []; arr.clear = () => arr.forEach(o => m.removeOverlay(o)); return arr; };
    map = m;
    return { inter: mk(), spots: mk(), route: mk() };
  },

  // 高德 JS API 2.0：与百度 GL 同为「整体替换」型后端，坐标直接用 GCJ-02
  _initAmap() {
    const m = new AMap.Map('map', {
      zoom: 5, center: [112.0, 32.8], viewMode: '2D', resizeEnable: true,
    });
    const mk = () => {
      const arr = [];
      arr.clear = () => { if (arr.length) { m.remove(arr); arr.length = 0; } };
      return arr;
    };
    map = m;
    return { inter: mk(), spots: mk(), route: mk() };
  },
};

let mapInitPromise = null;
function initMap() {
  if (map) return Promise.resolve(true);
  if (mapInitPromise) return mapInitPromise;  // 百度 GL 加载可能耗时数秒，重试时复用同一个初始化
  mapInitPromise = (async () => {
    const backend = await MAPAPI.pickBackend();
    if (backend === 'leaflet' && typeof L === 'undefined') return false;
    const groups = MAPAPI.init(backend);
    gInter = groups.inter; gSpots = groups.spots; gRoute = groups.route;
    return true;
  })();
  return mapInitPromise;
}

function waitMap(cb, tries = 80) {
  initMap().then(ok => {
    if (ok) { cb(); return; }
    if (tries <= 0) { toast('地图组件加载失败，请检查网络'); return; }
    setTimeout(() => waitMap(cb, tries - 1), 150);
  });
}

function fitPts(pts) { MAPAPI.fit(pts); }

function showIntercity() {
  if (!map) return;
  MAPAPI.clear(gInter);
  const a = state.from, b = state.to;
  MAPAPI.line(gInter, a, b, {
    color: '#7a746b', weight: 2.5, dash: '6,8',
    popup: `<b>${a.name} → ${b.name}</b><br>直线约 ${Math.round(hav(a, b))} km`,
  });
  [a, b].forEach(c => {
    MAPAPI.pin(gInter, c, { html: `<div class="pin city">${c.name}</div>`, w: 40, h: 22, z: 400 });
  });
  fitPts([a, b]);
}

function refreshSpotMarkers() {
  if (!map) return;
  Object.keys(spotMarkers).forEach(id => {
    const on = state.selected.includes(id);
    MAPAPI.setDotFill(spotMarkers[id], on ? '#1f6b4f' : '#a8a093');
  });
}

function showSpots(fit) {
  if (!map) return;
  MAPAPI.clear(gSpots);
  Object.keys(spotMarkers).forEach(k => delete spotMarkers[k]);
  const list = POIS[state.to.name] || [];
  if (!list.length) { loadFreeSpots(state.to.name); return; }
  list.forEach(p => {
    const m = MAPAPI.dot(gSpots, p, {
      fill: state.selected.includes(p.id) ? '#1f6b4f' : '#a8a093',
      popup: `<b>${p.name}</b><br>${tierLabel(p.tier)} · ${p.ticket ? '门票 ¥' + p.ticket : '免费'} · 建议玩 ${fmtDur(p.suggest_min)}<br>${p.note || ''}`,
      onClick: () => { if (state.step === 3) toggleSpot(p.id); },
    });
    spotMarkers[p.id] = m;
  });
  if (fit) fitPts(list);
}

function baiduNav(fromPt, toPt, mode, region) { // 百度 URI API 深链（免 AK，见 baidu.js）
  return MAPS.navUrl(fromPt, toPt, mode, region || state.to.name);
}

// 扁平段号 → 该段两端的点
function legEndpoints(legIdx) {
  const hub = hubOf(state.to);
  let acc = 0;
  for (const dayIds of getOrder()) {
    if (!dayIds.length) continue; // 空天不占路段
    const legs = dayIds.length + 1;
    if (legIdx < acc + legs) {
      const k = legIdx - acc + 1;
      const seq = [hub, ...dayIds.map(id => POIMAP[id]), hub];
      return [seq[k - 1], seq[k]];
    }
    acc += legs;
  }
  return null;
}

const routeModeOf = modeId => NAV_MODE[modeId] || 'driving';
const geoKeyOf = (a, b, modeId) => `${routeModeOf(modeId)}|${pairKey(a, b)}`;
const geoInFlight = new Map();   // key -> Promise，同一段并发请求只发一次
let geoSeq = 0;                  // 每次重绘的取数轮次，旧轮次拿到结果后不再继续

// 拉取（或复用）某段的真实道路折线；坐标变化后旧结果按 geoToken 丢弃。
function ensureGeo(a, b, modeId) {
  const key = geoKeyOf(a, b, modeId);
  if (routeGeo.has(key)) return Promise.resolve(routeGeo.get(key));
  if (geoInFlight.has(key)) return geoInFlight.get(key);
  const epoch = geoToken;
  const mode = routeModeOf(modeId);
  const p = MAPS.routeMode(a, b, mode, state.to.name, state.to.name)
    .then(r => {
      const good = r && r.path && r.path.length > 1 ? r : null;
      if (epoch === geoToken) routeGeo.set(key, good);
      return good;
    })
    .finally(() => geoInFlight.delete(key));
  geoInFlight.set(key, p);
  return p;
}

// 逐段拉百度真实道路折线；每拿到一段就重绘（不清空已画好的部分）。
// 2 QPS 的队列在 BAIDU.enqueue 里，服务端还有一道全局闸门，这里顺序请求即可。
async function fetchLegGeometry(legs) {
  if (!MAPS.available()) return false;
  const run = ++geoSeq;
  let changed = false;
  for (const { a, b, modeId } of legs) {
    if (run !== geoSeq) return changed;
    if (routeGeo.has(geoKeyOf(a, b, modeId))) continue;
    const r = await ensureGeo(a, b, modeId);
    if (run !== geoSeq) return changed;
    if (r) changed = true;
    // 成功或失败都重绘：失败段保留直线兜底，并让「加载中」计数前进
    if (state.step >= 4 && map) drawRoute(false, true);
  }
  // 全部取完后刷新一次时间轴：换乘组成与实时时长会出现在这一段
  if (changed && state.step >= 4) renderTimeline();
  return changed;
}

function showRouteLoading(text, done, total) {
  if (state.step < 4) return;  // 只在地图展示行程时提示
  const el = $('#routeLoading');
  if (!el) return;
  const t = $('#routeLoadingText');
  if (t) {
    const count = total != null && total > 0
      ? ` <b>${Math.max(0, done)}/${total}</b>` : '';
    t.innerHTML = `${esc(text || '正在加载详细路线')}${count}`;
  }
  el.classList.remove('hidden');
}
function hideRouteLoading() {
  const el = $('#routeLoading');
  if (el) el.classList.add('hidden');
}

function drawRoute(fit, skipFetch) {
  if (!map) { hideRouteLoading(); return; }
  gRoute.clear();
  if (state.step < 4 || !state.selected.length) { hideRouteLoading(); return; }
  const order = getOrder();
  if (!order.flat().length) { hideRouteLoading(); return; }
  const hub = hubOf(state.to);
  const allPts = [hub];
  const pins = [{ pt: hub, html: '<div class="pin hub">🏨</div>', popup: `<b>${esc(hub.name)}</b><br>${hub.hotel ? (hub.hasNav ? '已选酒店（按酒店出入口坐标）' : '已选酒店（百度地点坐标）') : '住宿 / 出发点（全程同一酒店）'}` }];
  const legs = [];
  const badges = [];
  let legIdx = 0;
  order.forEach((dayIds, di) => {
    if (!dayIds.length) return; // 空天（自由活动）不画线不占段
    const seq = [hub, ...dayIds.map(id => POIMAP[id]), hub];
    seq.forEach((p, k) => {
      if (!p.isHub) allPts.push(p);
      if (k === 0) return;
      // 段：优先用百度返回的真实道路折线，未返回前先画虚线兜底
      const a = seq[k - 1], b = seq[k];
      const km0 = roadKm(a, b);
      const opts = legOptsFor(km0, a, b);
      const chosen = opts.find(x => x.id === state.modes[legIdx]) || opts[opts.length - 1];
      const st = MODE_STYLE[chosen.id];
      const color = dayColor(di);  // 颜色表示第几天，线型表示交通方式
      const mode = routeModeOf(chosen.id);
      const geoKey = geoKeyOf(a, b, chosen.id);
      const geo = routeGeo.get(geoKey);
      const tried = routeGeo.has(geoKey);  // 已请求过（成功或失败）
      const real = geo && geo.path && geo.path.length > 1;
      const km = real && geo.km ? geo.km : km0;
      const min = real && geo.min ? geo.min : chosen.min;
      const cost = real && geo.cost != null ? geo.cost : chosen.cost;
      const url = baiduNav(a, b, mode);
      const popup = `<b>第 ${di + 1} 天 段 ${k} · ${chosen.name}${real ? '（百度实际路线）' : ''}</b><br>约 ${fmtDur(min)} · ${fmtCost(cost)} · ${fmtKm(km)}`
        + (real ? compositionHTML(geo, 'tleg-detail') : '')
        + `<br><a class="pop-nav" target="_blank" rel="noopener" href="${url}">🧭 在百度地图打开该段导航</a>`;
      if (real) {
        MAPAPI.path(gRoute, geo.path, { color, weight: st.w, dash: st.d, popup });
        geo.path.forEach(([lng, lat]) => allPts.push({ lng, lat }));
      } else {
        // 详细折线未到之前先用直线兜底；取数失败 / 未配 AK 时明确标注是直线示意
        const note = !MAPS.available()
          ? '<br><i>未配置百度 AK，按直线示意</i>'
          : tried ? '<br><i>未获取到详细路线，按直线示意</i>' : '<br><i>路线加载中…</i>';
        MAPAPI.line(gRoute, a, b, { color, weight: Math.max(2.5, st.w - 1), dash: st.d || '4,8', popup: popup + note });
      }
      // 路段中点放一个方式圆标：三种地图后端都能显示，不依赖虚线样式
      const mid = real
        ? { lng: geo.path[Math.floor(geo.path.length / 2)][0], lat: geo.path[Math.floor(geo.path.length / 2)][1] }
        : { lng: (a.lng + b.lng) / 2, lat: (a.lat + b.lat) / 2 };
      badges.push({ pt: mid, html: `<div class="mode-badge ${st.cls}">${st.icon}</div>`, popup });
      legs.push({ a, b, modeId: chosen.id });
      legIdx++;
      // 图钉（先收集，路径全部画完后再压在上层）
      if (b.isHub) return;
      pins.push({
        pt: b, html: `<div class="pin" style="background:${color}">${di + 1}·${k}</div>`,
        popup: `<b>第 ${di + 1} 天 第 ${k} 站 · ${esc(b.name)}</b><br>游玩约 ${fmtDur(b.suggest_min)} · ${b.ticket ? '门票 ¥' + b.ticket : '免费'}`
          + (b.entrance ? '<br><span class="muted">已使用百度地图实际出入口坐标</span>' : ''),
      });
    });
  });
  pins.forEach(({ pt, html, popup }) => MAPAPI.pin(gRoute, pt, { html, w: html.includes('hub') ? 26 : 30, h: 26, z: 500, popup }));
  // 方式圆标压在路线之上、编号图钉之下
  badges.forEach(({ pt, html, popup }) => MAPAPI.pin(gRoute, pt, { html, w: 22, h: 22, z: 300, popup }));
  if (fit) fitPts(allPts);
  // 详细路线还在取：地图先画直线兜底，并在右下角提示进度
  const pending = legs.filter(l => !routeGeo.has(geoKeyOf(l.a, l.b, l.modeId))).length;
  if (MAPS.available() && pending) {
    showRouteLoading('正在加载详细路线', legs.length - pending, legs.length);
  } else {
    hideRouteLoading();
  }
  if (!skipFetch) fetchLegGeometry(legs);
}

/* ================= 复制行程单 ================= */

function flatModeOf(order, dayIdx, k) { // 第 dayIdx 天第 k 段（1 起）的已选通勤方式
  let acc = 0;
  for (let d = 0; d < order.length; d++) {
    if (!order[d].length) continue; // 空天不占路段
    const legs = order[d].length + 1;
    if (d === dayIdx) return state.modes[acc + k - 1];
    acc += legs;
  }
  return null;
}

function buildItineraryText() {
  const t = computeTotals();
  const order = getOrder();
  const hub = hubOf(state.to);
  const ic = state.transport;
  const lines = [];
  const range = state.days.length > 1
    ? `${fmtDateCN(state.days[0])} — ${fmtDateCN(state.days[state.days.length - 1])} · 共 ${state.days.length} 天`
    : `${fmtDateCN(state.days[0])} · 当天往返`;
  lines.push(`【行程单】${state.from.name} → ${state.to.name}（${range}）`);
  const plan = intercityPlanLegs();
  if (ic && plan) {
    const pushLeg = l => {
      if (l.kind === 'ic') {
        lines.push(`  ${l.icon} ${l.name}：${l.from.name} → ${l.to.name}，约 ${fmtDur(l.min)} · ${fmtCost(l.cost)}`
          + (l.station ? '（具体航班 / 车次以票务平台为准）' : ''));
      } else {
        lines.push(`  ${l.icon} 接驳：${l.from.name} → ${l.to.name}，打车约 ${fmtDur(l.min)} / ${fmtCost(l.cost)}`
          + `；公交地铁约 ${fmtDur(l.altMin)} / ${fmtCost(l.altCost)}`);
      }
    };
    lines.push(`【去程】${state.days.length ? fmtDateCN(state.days[0]) : ''}`);
    plan.out.forEach(pushLeg);
    const dep = toMin(state.departTime);
    if (dep != null) {
      const total = dep + plan.out.reduce((s, l) => s + (l.min || 0), 0);
      const spill = Math.floor(total / 1440);
      lines.push(`  预计 ${spill ? `+${spill} 天 ` : ''}${fmtHM(total)} 抵达酒店`);
    }
    if (plan.back.length) {
      lines.push('【返程】');
      plan.back.forEach(pushLeg);
      const ret = toMin(state.returnTime);
      if (ret != null) {
        const total = ret + plan.back.reduce((s, l) => s + (l.min || 0), 0);
        const spill = Math.floor(total / 1440);
        lines.push(`  预计 ${spill ? `+${spill} 天 ` : ''}${fmtHM(total)} 回到 ${plan.p.depPt.name}`);
      }
    }
  } else if (ic) {
    let head = `城际：${ic.name} 约 ${fmtDur(ic.min)} · ${fmtCost(ic.cost)}`;
    lines.push(head);
  }
  order.forEach((dayIds, di) => {
    lines.push(`── 第 ${di + 1} 天 · ${fmtDateCN(state.days[di])} ──`);
    if (!dayIds.length) { lines.push('（自由活动）'); return; }
    const seq = [hub, ...dayIds.map(id => POIMAP[id]), hub];
    seq.forEach((p, k) => {
      if (k > 0) {
        const km = roadKm(seq[k - 1], p);
        const opts = legOptsFor(km, seq[k - 1], p);
        const mode = flatModeOf(order, di, k);
        const chosen = opts.find(x => x.id === mode) || opts[opts.length - 1];
        lines.push(`  ├ ${chosen.name}约 ${fmtDur(chosen.min)}${chosen.cost ? `（¥${Math.round(chosen.cost)}）` : ''}`);
      }
      if (p.isHub) {
        lines.push(`${k === 0 ? '● ' + p.name : '● 返回住宿地'}`);
      } else {
        lines.push(`${k}. ${p.name}　游玩约 ${fmtDur(p.suggest_min)}${p.ticket ? `　门票 ¥${p.ticket}` : ''}`);
      }
    });
  });
  lines.push(`市内通勤 ${fmtDur(t.moveMin)} / ${fmtKm(t.km)} · 门票 ${fmtCost(t.ticket)} · 全程约 ${fmtDur(t.totalMin)} · 合计 ${fmtCost(t.totalCost)}${t.accessCost ? `（含接驳 ${fmtCost(t.accessCost)}）` : ''}`);
  lines.push('（由跨城出行规划原型生成，时间为估算值）');
  return lines.join('\n');
}

function copyItinerary() {
  const text = buildItineraryText();
  const done = () => toast('行程单已复制，去粘贴给同行的人吧');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择文本'); }
  document.body.removeChild(ta);
}

/* ================= 出发点（从哪出发去车站/机场） ================= */

let departCity = null;
let departSeq = 0;
let departBusy = false;
let departDebounce = null;

function departLandmarks() {
  return CITY_LANDMARKS[state.from.name] || [];
}

function renderDepartQuick() {
  const box = $('#departPointQuick');
  if (!box) return;
  const cur = state.departPoint;
  const isDefault = !cur;
  box.innerHTML = `<button type="button" data-depart="default"${isDefault ? ' class="on"' : ''}>🏨 住宿地 / 默认</button>`
    + departLandmarks().map((m, i) => {
      const on = cur && !cur.custom && cur.name === m[0] ? ' class="on"' : '';
      return `<button type="button" data-depart="m${i}"${on}>📍 ${esc(m[0])}</button>`;
    }).join('');
}

function refreshDepartPointUI() {
  if (!$('#departPointPicked')) return;
  const picked = $('#departPointPicked');
  const hint = $('#departPointHint');
  const input = $('#departPointInput');
  const cur = state.departPoint;
  renderDepartQuick();
  if (cur) {
    picked.classList.remove('hidden');
    picked.innerHTML = `<span>📍 <b>${esc(cur.name)}</b>`
      + (cur.address ? `<br><span class="muted">${esc(cur.address)}</span>` : '')
      + (cur.hasNav ? '<br><span class="p-badge">已定位到实际出入口坐标</span>' : '')
      + `</span><button type="button" class="poi-clear" data-depart-clear="1">清除</button>`;
    hint.textContent = cur.hasNav
      ? '接驳里程按百度地图实际出入口计算。'
      : '接驳里程按所选位置的坐标估算；搜索候选会自动尝试定位实际出入口。';
    if (input) input.value = cur.name;
  } else {
    picked.classList.add('hidden');
    picked.innerHTML = '';
    hint.textContent = '默认从住宿地 / 市中心出发；也可输入任意地点并选中候选，按百度地图实际位置计算接驳。';
  }
}

// 出发城市变化时重置；同一座城市重复查询保留用户已选出发点
function fillDepartPoints() {
  if (departCity !== state.from.name) {
    departCity = state.from.name;
    state.departPoint = null;
    departSeq++;
    const input = $('#departPointInput');
    if (input) input.value = '';
  }
  $('#departPointResults').classList.add('hidden');
  refreshDepartPointUI();
}

function clearDepartPoint() {
  departSeq++;  // 作废在途的搜索 / 详情
  state.departPoint = null;
  $('#departPointResults').classList.add('hidden');
  const input = $('#departPointInput');
  if (input) input.value = '';
  refreshDepartPointUI();
  onDepartPointChange();
}

async function applyDepartCandidate(p, btn) {
  const city = state.from.name;
  const seq = ++departSeq;
  let use = p;
  let detailFail = false;
  // 模糊候选只有地址坐标：选中后查一次详情，拿 navi_location（真实出入口）
  if (p.uid) {
    const meta = btn ? btn.querySelector('.p-addr') : null;
    if (btn) {
      btn.disabled = true;
      if (meta) meta.textContent = '正在定位实际出入口…';
    }
    const detail = await MAPS.placeDetail(p.uid);
    if (btn) btn.disabled = false;
    if (seq !== departSeq || state.from.name !== city) return;
    if (detail) use = { ...p, ...detail };
    else detailFail = true;
  }
  if (state.from.name !== city) return;
  state.departPoint = {
    name: use.name || p.name || '自定义出发点',
    address: use.address || p.address || '',
    lng: use.navLng != null ? use.navLng : use.lng,
    lat: use.navLat != null ? use.navLat : use.lat,
    addrLng: use.lng, addrLat: use.lat,
    hasNav: !!use.hasNav,
    custom: true,
  };
  $('#departPointResults').classList.add('hidden');
  refreshDepartPointUI();
  onDepartPointChange();
  toast(use.hasNav
    ? `已定位「${state.departPoint.name}」出入口，并按此重算接驳`
    : detailFail
      ? `出入口坐标获取失败，先按「${state.departPoint.name}」的地址坐标计算`
      : `已按「${state.departPoint.name}」的位置重算接驳`);
}

async function searchDepartPoints() {
  clearTimeout(departDebounce);
  if (departBusy) return;
  const q = $('#departPointInput').value.trim();
  if (!q) return toast('请输入出发点名称或关键词');
  const city = state.from.name;
  const box = $('#departPointResults');
  const btn = $('#btnDepartSearch');
  box.classList.remove('hidden');
  box._places = null;
  box.innerHTML = '<p class="poi-empty">模糊搜索中…</p>';
  const seq = ++departSeq;
  departBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = '搜索中…'; }
  try {
    const places = await MAPS.suggestPlaces(q, city);
    if (seq !== departSeq || state.from.name !== city) return;
    if (!places.length) {
      box.innerHTML = `<p class="poi-empty">没有找到「${esc(q)}」`
        + (MAPS.lastError ? `<br>${esc(MAPS.lastError)}` : '')
        + '<br>换个关键词再试，或 <button type="button" data-depart-retry="1">重试</button></p>';
      return;
    }
    box._places = places;
    box.innerHTML = places.map((p, i) => {
      const meta = [p.address, p.tag].filter(Boolean).join(' · ');
      return `<button type="button" class="poi-item" data-depart-item="${i}">`
        + `<span class="p-name">${esc(p.name)}</span>`
        + `<span class="p-addr">${esc(meta || '百度地图候选')}</span>`
        + '</button>';
    }).join('');
  } finally {
    departBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '搜索'; }
  }
}

// 出发点变化后的联动（已查询过时立刻重算接驳）
function onDepartPointChange() {
  if (!state.intercity) return;
  state.boardStations = {};
  rebuildAccess();
  renderTransport(); // 任意步骤都刷新（元素在 DOM 里，只是卡片隐藏）
  if (state.step >= 4) { renderTimeline(); drawRoute(false); }
  ensureRoutes();
}

/* ================= 目的地情报面板（攻略库演示数据 + 检索 + AI 问答） ================= */

const GUIDE_LS = city => `guide.ai.${city}`;
function guideFor(city) {
  if (GUIDE_RAW[city]) return { ...GUIDE_RAW[city], ai: false };
  try {
    const raw = localStorage.getItem(GUIDE_LS(city));
    if (raw) return { ...JSON.parse(raw), ai: true };
  } catch (e) { /* 缓存损坏当作没有 */ }
  return null;
}

function retrieveGuide(city, q) { // 大字重合检索：问题与条目的二元组重合度排序
  const g = guideFor(city);
  if (!g) return [];
  const grams = s => {
    const t = (s || '').toLowerCase().replace(/\s/g, '');
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const qg = grams(q);
  const items = [];
  Object.entries({ food: '美食', stay: '住宿', tips: '贴士', ideas: '灵感' }).forEach(([k, cat]) => {
    (g[k] || []).forEach(i => items.push({ cat, ...i, _g: grams(i.t + i.d) }));
  });
  const score = item => {
    let s = 0;
    qg.forEach(x => { if (item._g.has(x)) s++; });
    return s;
  };
  return items.map(i => ({ ...i, score: score(i) }))
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function renderGuide() {
  const city = state.to.name;
  const g = guideFor(city);
  const labels = { food: '🍜 美食', stay: '🏨 住宿', tips: '⚠️ 贴士', ideas: '💡 灵感' };
  $$('#guideTabs button').forEach(b => {
    b.classList.toggle('on', b.dataset.gtab === state.guideTab);
    b.textContent = labels[b.dataset.gtab];
  });
  const banner = $('#guideBanner');
  if (!g) {
    banner.className = 'g-banner ai';
    banner.textContent = '该城市暂无攻略条目；配置 AI 通道后可一键生成（生成结果仅供参考）。';
    $('#guideList').innerHTML = '';
    $('#guideGen').classList.remove('hidden');
    return;
  }
  banner.className = 'g-banner' + (g.ai ? ' ai' : '');
  banner.textContent = g.ai
    ? '⚠ 以下内容由 AI 生成（本机缓存），仅供参考，出行前自行核实。'
    : `演示数据：2026-10 联网检索公开攻略（知乎/携程社区/去哪儿/网易旅游等）整理；接入携程/同程开放平台后整体替换。`;
  $('#guideGen').classList.add('hidden');
  const kw = ($('#guideSearch').value || '').trim().toLowerCase();
  let items = (g[state.guideTab] || []);
  if (kw) items = items.filter(i => (i.t + i.d + (i.src || '')).toLowerCase().includes(kw));
  $('#guideList').innerHTML = items.length
    ? items.map(i => `<div class="g-item"><div class="g-t">${i.t}</div><div class="g-d">${i.d}</div>`
      + `<div class="g-src">来源：${i.src || '公开攻略整理'}</div></div>`).join('')
    : `<div class="g-item muted">没有匹配「${kw}」的条目，换个关键词，或直接在下方问 AI。</div>`;
}

async function aiGenGuide() {
  if (!aiGuard() || !aiBegin()) return;
  try {
    const city = state.to.name;
    $('#guideGen').textContent = '生成中…';
    const messages = [
      { role: 'system', content: '你是旅行攻略编辑。为目的地城市生成简明攻略 JSON：{"food":[{"t":"条目名","d":"两句话说明"}],"stay":[...],"tips":[...],"ideas":[{"t":"行程名","d":"按天一句话"}]}。food/stay/tips 各 3-4 条，ideas 1-2 条；内容基于你的公开常识，不要编造具体店名价格，用「区域/类型」表述；只输出 JSON。' },
      { role: 'user', content: `目的地：${city}` },
    ];
    const r = await AI.chat(messages, { task: 'guide', temperature: 0.5, maxTokens: 1200 });
    $('#guideGen').textContent = '让 AI 生成该城市攻略';
    if (!r.ok) return toast(`生成失败：${r.error.slice(0, 80)}`);
    const data = AI.extractJSON(r.content);
    if (!data || !data.food) return toast('AI 返回内容无法解析为攻略，请重试');
    data.food = (data.food || []).map(i => ({ ...i, src: 'AI 生成，仅供参考' }));
    data.stay = (data.stay || []).map(i => ({ ...i, src: 'AI 生成，仅供参考' }));
    data.tips = (data.tips || []).map(i => ({ ...i, src: 'AI 生成，仅供参考' }));
    data.ideas = (data.ideas || []).map(i => ({ ...i, src: 'AI 生成，仅供参考' }));
    localStorage.setItem(GUIDE_LS(city), JSON.stringify(data));
    renderGuide();
    toast(`已生成「${city}」攻略（存本机缓存）`);
  } finally {
    aiEnd();
  }
}

async function guideAsk() {
  const q = $('#guideQ').value.trim();
  if (!q) return toast('输入问题，比如「住哪个区域」「必吃什么」');
  if (!aiGuard() || !aiBegin()) return;
  try {
    const city = state.to.name;
    const ctx = retrieveGuide(city, q);
    const ctxText = ctx.map(i => `- [${i.cat}] ${i.t}：${i.d}（${i.src}）`).join('\n') || '（攻略库暂无该城市条目）';
    const pois = (POIS[city] || []).map(p => `${p.name}（${tierLabel(p.tier)}；${p.note || ''}）`).join('；') || '（该城市暂无景点数据）';
    openAiOut('🤖 目的地问答', '检索攻略库并生成回答…');
    const messages = [
      { role: 'system', content: '你是目的地攻略问答助手。只允许基于给定条目回答；引用条目时注明来源；条目里没有的信息直说「攻略库里没有，建议出行前自行核实」，禁止编造店名/价格/时刻。用中文简洁回答。' },
      { role: 'user', content: `问题：${q}\n\n攻略库检索条目：\n${ctxText}\n\n已收录景点备注：\n${pois}` },
    ];
    const r = await AI.chat(messages, { task: 'qa', temperature: 0.4, maxTokens: 600 });
    setAiOut((r.ok ? r.content : `❌ ${r.error}`)
      + `\n\n—— 检索命中 ${ctx.length} 条攻略条目${AI.cfg.provider === 'demo' ? '（离线演示模式未调用大模型）' : ''}`);
  } finally {
    aiEnd();
  }
}

/* ================= AI 功能（通道见 ai.js；LLM 只转述结构化事实） ================= */

function aiGuard() {
  if (AI.ready()) return true;
  openAiSettings();
  toast('先在「AI 设置」里选一个通道（OpenRouter 有免费模型，或用离线演示）');
  return false;
}

// 防重复：AI 请求可能长达数十秒，连点会并发排队多个请求，输出框互相覆盖且更慢
let aiBusy = false;
function aiBegin() {
  if (aiBusy) { toast('AI 正在处理上一个请求，请等它完成（或点 ✕ 关闭后重试）'); return false; }
  aiBusy = true;
  return true;
}
function aiEnd() { aiBusy = false; }

function openAiSettings() {
  $('#aiProvider').innerHTML = Object.entries(AI_PROVIDERS)
    .map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  $('#aiProvider').value = AI.cfg.provider;
  $('#aiBaseURL').value = AI.cfg.baseURL || AI_PROVIDERS[AI.cfg.provider].baseURL || '';
  $('#aiModel').value = AI.cfg.model || AI_PROVIDERS[AI.cfg.provider].model || '';
  $('#aiKey').value = AI.cfg.key || '';
  $('#aiProviderHint').textContent = AI_PROVIDERS[AI.cfg.provider].hint;
  // 演示模式不需要任何凭据：隐藏真实通道字段，避免"填了却不生效"的误导
  $('#aiRealFields').classList.toggle('hidden', AI.cfg.provider === 'demo');
  $('#baiduAk').value = BAIDU.key || '';
  $('#baiduAkBrowser').value = BAIDU.browserKey || '';
  $('#routeProviderPref').value = MAPS.prefs.route;
  $('#placeProviderPref').value = MAPS.prefs.place;
  $('#baiduStatus').textContent = MAPS.statusText() + ' ｜ ' + BAIDU.browserStatus()
    + (AI.server ? ' · 本地 serve.py 代理在线' : ' · 未检测到本地 serve.py');
  $('#aiStatus').textContent = AI.statusText()
    + (AI.server ? ' · 本地 serve.py 代理在线' : ' · 未检测到本地 serve.py（file:// 或纯静态打开）');
  loadCacheConfig();
  $('#aiModal').classList.remove('hidden');
}

function fmtCacheSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

async function loadCacheConfig() {
  const el = $('#cacheStatus');
  if (!el) return;
  try {
    const r = await fetch('/api/cache/config', { cache: 'no-store' });
    const d = r.ok ? await r.json() : null;
    if (!d || !d.ok) throw new Error((d && d.error) || `返回 ${r.status}`);
    $('#cacheMaxMb').value = d.maxMb;
    const secs = Object.entries(d.sections || {})
      .map(([k, n]) => `${({ places: '地点', routes: '路线', free_places: '免费地点', free_pois: '免费景点' })[k] || k} ${n}`)
      .join(' · ');
    el.textContent = `已用 ${fmtCacheSize(d.sizeBytes)}，共 ${d.entries} 条`
      + (secs ? `（${secs}）` : '')
      + ` · 上限 ${d.maxMb} MB；超出后按使用频率从低到高自动清理。`;
  } catch (e) {
    el.textContent = '未连接本地 serve.py，缓存设置不可用（页面其余功能不受影响）。';
  }
}

async function saveCacheConfig() {
  const input = $('#cacheMaxMb');
  const mb = Number(input.value);
  if (!input.value || !Number.isFinite(mb)) return toast('请输入缓存上限（MB）');
  try {
    const r = await fetch('/api/cache/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxMb: mb }),
    });
    const d = await r.json();
    if (!d.ok) return toast(d.error || '保存失败');
    toast(`缓存上限已设为 ${d.maxMb} MB，当前占用 ${fmtCacheSize(d.sizeBytes)}`);
    loadCacheConfig();
  } catch (e) {
    toast('保存失败：本地 serve.py 未连接');
  }
}

async function testAi() {
  if (!aiBegin()) return;
  try {
    $('#aiStatus').textContent = '测试连通中…';
    const r = await AI.chat([{ role: 'user', content: '收到请只回复：ok' }], { task: 'test', maxTokens: 8, timeoutMs: 20000 });
    $('#aiStatus').textContent = r.ok
      ? `✅ 连通正常（${r.via === 'demo' ? '离线演示' : r.via === 'proxy' ? '本地代理' : '直连'}）`
      : `❌ ${r.error}`;
  } finally {
    aiEnd();
  }
}

function openAiOut(title, body) {
  $('#aiOutTitle').textContent = title;
  $('#aiOutBody').textContent = body;
  $('#aiOutBody').classList.add('loading');
  $('#aiOut').classList.remove('hidden');
}
function setAiOut(text) {
  $('#aiOutBody').textContent = text;
  $('#aiOutBody').classList.remove('loading');
}

function buildPlanJSON() { // 只打包结构化事实给 LLM，遵守"表达层禁止新增事实"
  const t = computeTotals();
  const order = getOrder();
  const hub = hubOf(state.to);
  const p = accessPairs();
  const acc = state.access;
  return {
    summary: {
      from: state.from.name,
      to: state.to.name,
      departPoint: p ? p.depPt.name : null,
      days: state.days.length,
      dates: `${state.days[0]} ~ ${state.days[state.days.length - 1]}`,
      intercity: state.transport ? {
        mode: state.transport.name,
        duration_min: Math.round(state.transport.min),
        cost: Math.round(state.transport.cost),
        board: p && p.fromSt ? p.fromSt.name : null,
        alight: p && p.toSt ? p.toSt.name : null,
      } : null,
      access: acc ? {
        depart_side: acc.from && p.fromSt ? `${p.depPt.name}→${p.fromSt.name} 打车${Math.round(acc.from.taxi.min)}分钟 ${acc.from.taxi.cost}元（${acc.from.src}）` : null,
        arrive_side: acc.to && p.toSt ? `${p.toSt.name}→${p.destHub.name} 打车${Math.round(acc.to.taxi.min)}分钟 ${acc.to.taxi.cost}元（${acc.to.src}）` : null,
      } : null,
      total: { minutes: Math.round(t.totalMin), cost: Math.round(t.totalCost) },
    },
    dayLines: order.map((dayIds, di) => {
      const seq = [hub, ...dayIds.map(id => POIMAP[id]), hub];
      return {
        day: di + 1,
        date: state.days[di],
        stops: dayIds.map(id => {
          const s = POIMAP[id];
          return { name: s.name, play_min: s.suggest_min, ticket: s.ticket, note: s.note || '' };
        }),
        legs: dayIds.length ? [...Array(dayIds.length + 1)].map((_, k) => {
          const km = roadKm(seq[k], seq[k + 1]);
          const o = legOptsFor(km, seq[k], seq[k + 1]).find(x => x.id === flatModeOf(order, di, k + 1)) || {};
          return { from: seq[k].name, to: seq[k + 1].name, mode: o.name, min: Math.round(o.min || 0) };
        }) : [],
      };
    }),
  };
}

async function aiExplain() {
  if (!aiGuard() || !aiBegin()) return;
  try {
    if (!getOrder().flat().length) return toast('请先生成行程方案');
    openAiOut('🤖 AI 行程讲解', '基于结构化行程生成讲解…');
    const messages = [
      { role: 'system', content: '你是行程讲解助手，用户给你一份结构化行程 JSON。硬性规则：只允许转述 JSON 里出现过的地点、时刻、金额、交通方式，禁止新增任何地点/车次/时刻/价格；用中文；先总述（天数/城际/总花费），再逐天讲为什么这样排（只能引用 JSON 里的 note 与顺序关系），最后给 2-3 条贴士（只能来自 note 字段）。' },
      { role: 'user', content: JSON.stringify(buildPlanJSON()) },
    ];
    const r = await AI.chat(messages, { task: 'explain', temperature: 0.4, maxTokens: 800 });
    setAiOut((r.ok ? r.content : `❌ ${r.error}`)
      + (AI.cfg.provider === 'demo' ? '\n\n（离线演示模式：内容由页面内结构化数据汇总生成，未调用大模型）' : ''));
  } finally {
    aiEnd();
  }
}

/* --- 一句话生成行程 --- */
function nlParseLocal(text) { // 离线兜底：只识别「城市 + N 天」
  const days = (text.match(/(\d+)\s*天/) || [])[1];
  const names = Object.keys(CITYMAP).sort((a, b) => b.length - a.length);
  const city = names.find(n => text.includes(n));
  return city ? { city, days: days ? +days : null } : null;
}

async function aiNLPlan() {
  const text = $('#nlInput').value.trim();
  if (!text) return toast('先描述需求，例：下周去成都玩 3 天，预算 3000');
  if (!aiGuard() || !aiBegin()) return;
  try {
    let slots = null;
    if (AI.cfg.provider === 'demo') {
      slots = nlParseLocal(text);
      if (!slots) {
        openAiOut('✨ 一句话规划', '离线模式只支持「城市 + 天数」格式（例：成都 3 天）。配置 AI 通道后可解析任意描述。');
        return;
      }
    } else {
      openAiOut('✨ 一句话规划', '解析需求中…');
      const today = fmtISO(new Date());
      const messages = [
        { role: 'system', content: `把用户的一句旅行需求解析成 JSON，字段：city（中国地级市名，不带"市"后缀）、days（整数）、start_date（YYYY-MM-DD；今天是 ${today}，"下周/明天"等相对日期据此推算，无法确定则 null）、party（同行人描述或 null）、budget（每人预算数字或 null）、interests（兴趣标签数组，可为空数组）。只输出 JSON。` },
        { role: 'user', content: text },
      ];
      const r = await AI.chat(messages, { task: 'nlplan', temperature: 0.1, maxTokens: 300 });
      if (!r.ok) return setAiOut(`❌ ${r.error}`);
      slots = AI.extractJSON(r.content);
      if (!slots) return setAiOut('没能从回复里解析出 JSON，原始回复：\n' + r.content.slice(0, 500));
    }
    applySlots(slots, text);
  } finally {
    aiEnd();
  }
}

function applySlots(slots, rawText) {
  // 城市名归一：精确 → 去后缀 → 双向包含
  let city = slots.city && CITYMAP[slots.city] ? slots.city : null;
  if (!city && slots.city) {
    const want = String(slots.city).replace(/(特别行政区|市|地区|盟|自治州)$/g, '');
    city = Object.keys(CITYMAP).find(n => n === want)
      || Object.keys(CITYMAP).find(n => n.includes(want) || want.includes(n));
  }
  if (!city) {
    setAiOut(`没认出目的地「${slots.city || '（空）'}」。这句话是：${rawText}\n\n请手动在步骤①选择城市，或换个写法（例：下周去成都玩 3 天）。`);
    return;
  }
  const days = Math.max(1, Math.min(14, +slots.days || 3));
  let start = slots.start_date && /^\d{4}-\d{2}-\d{2}$/.test(slots.start_date) ? slots.start_date : fmtISO(new Date());
  $('#toSel').value = city;
  if (slots.from && CITYMAP[slots.from]) {
    $('#fromSel').value = slots.from;
    state.from = CITYMAP[slots.from];
  }
  state.to = CITYMAP[city];
  syncComboInputs();
  $('#arriveDate').value = start;
  $('#returnDate').value = addDaysStr(start, days - 1);
  updateTripHint();
  doQuery();
  // 按兴趣预选景点：关键词匹配名称/备注/分级，匹配不到就按满意度取每天约 3 个
  const list = POIS[city] || [];
  if (list.length) {
    const ints = Array.isArray(slots.interests) ? slots.interests.filter(Boolean) : [];
    let picked = [];
    if (ints.length) {
      picked = list.filter(p => ints.some(kw =>
        (p.name + (p.note || '') + tierLabel(p.tier)).includes(kw)));
    }
    if (picked.length < days) {
      const top = list.slice().sort((a, b) => b.satisfaction - a.satisfaction)
        .filter(p => !picked.includes(p))
        .slice(0, Math.min(list.length, days * 3));
      picked = picked.concat(top);
    }
    state.selected = picked.slice(0, days * 4).map(p => p.id);
  }
  renderSpots();
  refreshSpotMarkers();
  $('#btnPlan').click();
  const party = slots.party ? ` · ${slots.party}` : '';
  const budget = slots.budget ? ` · 预算 ${slots.budget}/人` : '';
  setAiOut(`已按解析结果生成行程：\n目的地 ${city} · ${days} 天（${fmtDateCN(start)} 起）${party}${budget}\n兴趣：${(slots.interests || []).join('、') || '未指定'} → 已预选 ${state.selected.length} 个景点\n\n所有槽位都可以回到步骤① 修改后重新查询。`);
}

/* ================= 步骤切换 ================= */

function gotoStep(n) {
  for (let i = 1; i <= 5; i++) $('#card' + i).classList.toggle('hidden', i !== n);
  $$('#stepper li').forEach(li => {
    const s = +li.dataset.step;
    li.classList.toggle('on', s === n);
    li.classList.toggle('done', s < n);
    li.classList.toggle('can', s <= state.maxStep && s !== n);
  });
  state.step = n;
  state.maxStep = Math.max(state.maxStep, n);
  document.body.dataset.step = String(n);  // 供移动端按步骤调整地图高度
  $('#legend').classList.toggle('hidden', n < 4);
  $('#mapHint').textContent = [
    '选择出发地与目的地（全国地级市）和时间段，点「查询交通方式」',
    '两地位置与交通对比；地图上可先看目的地景点分布',
    '地图即景点分布：点圆点或左侧卡片勾选景点，可按分类筛选',
    '行程按天分组：图钉 = 天·序号，颜色对应通勤方式，点线段可跳转导航',
    '点任意线段或图钉，可在百度地图中打开导航',
  ][n - 1];
  if (n === 2) showIntercity();
  if (n === 3) showSpots(false);
  if (n >= 4) drawRoute(true);
  else hideRouteLoading();
}

/* ================= 查询与方案 ================= */

function updateTripHint() {
  const a = $('#arriveDate').value || addDaysStr(new Date().toISOString().slice(0, 10), 0);
  const b = $('#returnDate').value;
  if (!b) {
    $('#tripHint').textContent = `当天往返：仅 ${fmtDateCN(a)} 一天（填返程日即为多日行程）`;
    return;
  }
  const n = Math.round((dateObj(b) - dateObj(a)) / 86400000) + 1;
  if (n < 1) $('#tripHint').textContent = '⚠ 返程日早于出发日';
  else if (n > 14) $('#tripHint').textContent = '⚠ 最多支持 14 天';
  else $('#tripHint').textContent = `行程共 ${n} 天：${fmtDateCN(a)} → ${fmtDateCN(b)}`;
}

function doQuery() {
  refreshHotelUI();
  state.departTime = $('#departTime').value || '';
  state.returnTime = $('#returnTime').value || '';
  const a = $('#arriveDate').value, b = $('#returnDate').value;
  const ret = b || a;
  const n = Math.round((dateObj(ret) - dateObj(a)) / 86400000) + 1;
  if (n < 1) return toast('返程日不能早于出发日');
  if (n > 14) return toast('最多支持 14 天，请缩短时间段');
  state.arriveDate = a;
  state.returnDate = ret;
  state.days = [...Array(n)].map((_, i) => addDaysStr(a, i));
  state.transport = null;
  state.selected = [];
  state.spotTier = 'all';
  resetStationSearch();
  fillDepartPoints();
  state.boardStations = {};
  state.intercity = intercityOptions(state.from, state.to);
  rebuildAccess();
  renderTransport();
  ensureRoutes();
  $('#btnTo3').disabled = true;
  waitMap(() => { showIntercity(); showSpots(false); });
  gotoStep(2);
}

function applyScheme(name) {
  state.scheme = name;
  $$('#schemeTabs button').forEach(b => b.classList.toggle('on', b.dataset.scheme === name));
  initModes();
  renderTimeline();
  drawRoute(true);
}

/* ================= 目的地酒店搜索 ================= */

let hotelSeq = 0;
let hotelBusy = false;
let hotelApplySeq = 0;
function selectedHotel() { return state.hotels[state.to.name] || null; }

function refreshHotelUI() {
  const h = selectedHotel();
  const hint = $('#hotelHint');
  const box = $('#hotelResults');
  if (h) {
    hint.textContent = '';
    box.classList.remove('hidden');
    box.innerHTML = `<div class="hotel-picked"><span>🏨 <b>${esc(h.name)}</b>`
      + (h.address ? `<br><span class="muted">${esc(h.address)}</span>` : '')
      + (h.hasNav ? '<br><span class="h-badge">已定位到酒店出入口坐标</span>' : '')
      + `</span><button type="button" class="hotel-clear" data-hotel-clear="1">清除</button></div>`;
  } else {
    box.classList.add('hidden');
    box.innerHTML = '';
    hint.textContent = '不指定时按市中心默认住宿估算；选定后全程以酒店出入口为起终点';
  }
}

async function searchHotels() {
  if (hotelBusy) return;
  const q = $('#hotelInput').value.trim();
  if (!q) return toast('请输入酒店名称或关键词');
  const city = state.to.name;
  const box = $('#hotelResults');
  const btn = $('#btnHotelSearch');
  box.classList.remove('hidden');
  box._places = null;
  box.innerHTML = '<p class="muted" style="padding:10px 12px">模糊搜索中…</p>';
  const seq = ++hotelSeq;
  hotelApplySeq++;  // 新搜索开始后，之前未完成的选点详情作废
  hotelBusy = true;
  btn.disabled = true;
  btn.textContent = '搜索中…';
  try {
    // 走百度地点输入提示（suggestion）：关键词不必完整命中 POI 名称
    const places = await MAPS.suggestPlaces(q, city);
    if (seq !== hotelSeq || state.to.name !== city) return;
    if (!places.length) {
      box.innerHTML = `<p class="muted" style="padding:10px 12px">没有找到「${esc(q)}」`
        + (MAPS.lastError ? `<br>${esc(MAPS.lastError)}` : '')
        + '<br>换个关键词再试，或 <button type="button" class="hotel-retry" data-hotel-retry="1">重试</button></p>';
      return;
    }
    box._places = places;
    box.innerHTML = places.map((p, i) => {
      const meta = [p.address, p.tag].filter(Boolean).join(' · ');
      return `<button type="button" class="hotel-item" data-hotel="${i}">`
        + `<span class="h-name">${esc(p.name)}</span>`
        + `<span class="h-addr">${esc(meta || '百度地图候选')}</span>`
        + '</button>';
    }).join('');
  } finally {
    hotelBusy = false;
    btn.disabled = false;
    btn.textContent = '搜索';
  }
}

function redrawAfterHotelChange() {
  rebuildAccess();
  if (state.step === 2 && state.transport) renderTransport();
  ensureRoutes();
  if (state.step >= 4) {
    computeSchemes();
    initModes();
    renderTimeline();
    drawRoute(true);
  } else if (state.step === 3) {
    renderSpots();
    showSpots(false);
  } else if (state.step === 2) {
    showIntercity();
  }
}

async function applyHotel(p, btn) {
  const city = state.to.name;
  const seq = ++hotelApplySeq;
  let use = p;
  let detailFail = false;
  // 模糊搜索只给地址坐标；选中后查一次详情，拿 navi_location（酒店真正的大门）
  if (p.uid) {
    const meta = btn ? btn.querySelector('.h-addr') : null;
    const metaText = meta ? meta.textContent : '';
    if (btn) {
      btn.disabled = true;
      if (meta) meta.textContent = '正在定位酒店出入口…';
    }
    const detail = await MAPS.placeDetail(p.uid);
    if (btn) btn.disabled = false;
    if (meta) meta.textContent = metaText;
    // 用户中途换了目的地或重新搜索/选别的酒店：丢弃这次结果
    if (seq !== hotelApplySeq || state.to.name !== city) return;
    if (detail) use = { ...p, ...detail };
    else detailFail = true;
  }
  if (state.to.name !== city) return;
  state.hotels[city] = {
    name: use.name || p.name || '已选酒店',
    address: use.address || p.address || '',
    lng: use.navLng != null ? use.navLng : use.lng,
    lat: use.navLat != null ? use.navLat : use.lat,
    addrLng: use.lng, addrLat: use.lat,
    hasNav: !!use.hasNav,
  };
  resetRoutes();
  $('#hotelInput').value = use.name || p.name || '';
  refreshHotelUI();
  redrawAfterHotelChange();
  toast(use.hasNav
    ? `已定位「${use.name || p.name}」出入口，并按此重算路线`
    : detailFail
      ? `出入口坐标获取失败，先按「${use.name || p.name}」的地址坐标计算`
      : `已按「${use.name || p.name}」的位置重新计算路线`);
}

function clearHotel() {
  if (!state.hotels[state.to.name]) return;
  hotelApplySeq++;  // 取消还在飞的详情请求
  delete state.hotels[state.to.name];
  resetRoutes();
  $('#hotelInput').value = '';
  refreshHotelUI();
  redrawAfterHotelChange();
  toast('已清除酒店，恢复按市中心估算');
}

/* ================= 事件绑定 ================= */

function fillCitySelect(sel, def) {
  sel.innerHTML = PROVINCE_CITIES.map(([province, list]) =>
    `<optgroup label="${province}">`
    + list.map(([name]) => `<option value="${name}">${name}</option>`).join('')
    + '</optgroup>').join('');
  sel.value = def;
}

/* 城市选择：一个框同时负责「搜索」和「选择」
 * 输入即过滤，点条目立刻生效（不需要回车）；点右侧箭头展开完整分组列表。
 * 真正的值仍写回隐藏的 <select>，其余逻辑不用改。 */
function syncComboInputs() {
  const f = $('#fromComboInput'), t = $('#toComboInput');
  if (f) f.value = $('#fromSel').value;
  if (t) t.value = $('#toSel').value;
}

function initCityCombo(selId, inputId, listId) {
  const sel = $('#' + selId), input = $('#' + inputId), list = $('#' + listId);
  if (!sel || !input || !list) return;
  const items = [...sel.querySelectorAll('option')].map(o => ({
    city: o.value,
    group: o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '',
  }));
  let active = -1;

  const render = (q) => {
    const needle = (q || '').trim().toLowerCase();
    const hits = items.filter(it => !needle || it.city.toLowerCase().includes(needle));
    active = hits.length ? 0 : -1;
    let html = '', last = null;
    hits.forEach((it, i) => {
      if (it.group !== last) {
        html += `<div class="combo-group">${esc(it.group)}</div>`;
        last = it.group;
      }
      html += `<div class="combo-item${i === active ? ' active' : ''}" data-city="${esc(it.city)}">${esc(it.city)}</div>`;
    });
    list.innerHTML = html || '<div class="combo-empty">没有匹配的城市</div>';
  };
  const open = () => { list.classList.remove('hidden'); input.setAttribute('aria-expanded', 'true'); };
  const close = () => { list.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); };
  const choose = (city) => {
    if (!CITYMAP[city]) return;
    sel.value = city;
    sel.dispatchEvent(new Event('change'));
    input.value = city;
    close();
  };

  input.addEventListener('focus', () => { render(''); open(); input.select(); });
  input.addEventListener('click', () => { render(''); open(); });
  input.addEventListener('input', () => { render(input.value); open(); });  // 边打边筛，不用回车

  const arrow = input.parentElement.querySelector('.combo-arrow');
  if (arrow) arrow.addEventListener('click', (e) => {
    e.preventDefault();
    if (list.classList.contains('hidden')) { render(''); open(); input.focus(); } else close();
  });

  // mousedown 而不是 click：抢在输入框失焦前选中
  list.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.combo-item');
    if (!it) return;
    e.preventDefault();
    choose(it.dataset.city);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.combo')) close();
  });

  input.addEventListener('keydown', (e) => {
    const els = [...list.querySelectorAll('.combo-item')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.classList.contains('hidden')) { render(''); open(); }
      if (!els.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length;
      els.forEach((el, i) => el.classList.toggle('active', i === active));
      els[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();  // 回车只是可选加速键
      if (els[active]) choose(els[active].dataset.city);
      else if (els[0]) choose(els[0].dataset.city);
    } else if (e.key === 'Escape') {
      close();
      input.value = sel.value;
    }
  });

  sel.addEventListener('change', syncComboInputs);
  input.value = sel.value;
}

function bind() {
  fillCitySelect($('#fromSel'), state.from.name);
  fillCitySelect($('#toSel'), state.to.name);
  initCityCombo('fromSel', 'fromComboInput', 'fromComboList');
  initCityCombo('toSel', 'toComboInput', 'toComboList');
  fillDepartPoints();
  refreshHotelUI();
  const today = fmtISO(new Date());
  $('#arriveDate').value = today;
  $('#returnDate').value = addDaysStr(today, 2);
  updateTripHint();
  ['arriveDate', 'returnDate', 'departTime', 'returnTime'].forEach(id => {
    $('#' + id).addEventListener('change', updateTripHint);
  });

  // 目的地酒店搜索
  $('#btnHotelSearch').addEventListener('click', searchHotels);
  $('#hotelInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchHotels(); }
  });
  $('#hotelResults').addEventListener('click', e => {
    if (e.target.closest('[data-hotel-clear]')) { clearHotel(); return; }
    if (e.target.closest('[data-hotel-retry]')) { searchHotels(); return; }
    const b = e.target.closest('[data-hotel]');
    if (!b || b.disabled) return;
    const p = ($('#hotelResults')._places || [])[+b.dataset.hotel];
    if (p) applyHotel(p, b).catch(err => toast(`选用酒店失败：${err && err.message ? err.message : err}`));
  });
  $('#fromSel').addEventListener('change', () => {
    const c = CITYMAP[$('#fromSel').value];
    if (!c) return;
    state.from = c;
    clearBoardStations('from');  // 出发城市变了，只作废出发侧的车站 / 机场
    resetStationSearch('from');
    fillDepartPoints();  // 出发城市变了：重置出发点与常用地点
  });
  $('#toSel').addEventListener('change', () => {
    const c = CITYMAP[$('#toSel').value];
    if (c) state.to = c;
    clearBoardStations('to');
    resetStationSearch('to');
    hotelSeq++; hotelApplySeq++;  // 目的地变了，旧城市的搜索/选中作废
    refreshHotelUI();
  });

  $('#btnSwap').addEventListener('click', () => {
    const f = $('#fromSel').value;
    $('#fromSel').value = $('#toSel').value;
    $('#toSel').value = f;
    syncComboInputs();
  });

  $('#quickCities').addEventListener('click', e => {
    const b = e.target.closest('button[data-city]');
    if (!b) return;
    $('#toSel').value = b.dataset.city;
    syncComboInputs();
    state.from = CITYMAP[$('#fromSel').value];
    state.to = CITYMAP[b.dataset.city];
    doQuery();
  });

  $('#btnQuery').addEventListener('click', () => {
    const f = CITYMAP[$('#fromSel').value], t = CITYMAP[$('#toSel').value];
    if (!f || !t) return toast('请选择出发地和目的地');
    if (f.name === t.name) return toast('出发地和目的地不能是同一座城市');
    state.from = f; state.to = t;
    doQuery();
  });

  // 步骤 2
  $('#transportList').addEventListener('click', e => {
    const card = e.target.closest('.tcard');
    if (!card || card.classList.contains('off')) return;
    state.transport = state.intercity.list.find(o => o.id === card.dataset.id);
    resetStationSearch();  // 换城际方式后，上一方式的搜索候选 / 输入作废
    rebuildAccess();
    renderTransport();
    ensureRoutes();
    $('#btnTo3').disabled = false;
  });
  $('#btnTo3').addEventListener('click', () => {
    renderSpots();
    waitMap(() => showSpots(true));
    gotoStep(3);
  });

  // 步骤 3
  $('#tierFilter').addEventListener('click', e => {
    const b = e.target.closest('button[data-tier]');
    if (!b) return;
    state.spotTier = b.dataset.tier;
    renderSpots();
  });
  $('#spotGrid').addEventListener('click', e => {
    const jump = e.target.closest('button[data-goto-city]');
    if (jump) {
      const name = jump.dataset.gotoCity;
      $('#toSel').value = name;
      syncComboInputs();
      state.to = CITYMAP[name];
      refreshHotelUI();
      state.transport = null;
      state.selected = [];
      state.boardStations = {};
      state.intercity = intercityOptions(state.from, state.to);
      rebuildAccess();
      renderTransport();
      ensureRoutes();
      $('#btnTo3').disabled = true;
      toast(`目的地改为「${name}」，请重新选择城际交通`);
      waitMap(() => { showIntercity(); showSpots(false); });
      gotoStep(2);
      return;
    }
    const retry = e.target.closest('[data-free-retry]');
    if (retry) {
      const city = state.to.name;
      const entry = freeSpotState[city];
      if (entry) { entry.failedAt = 0; entry.error = ''; entry.loading = false; }
      loadFreeSpots(city);
      return;
    }
    const card = e.target.closest('.spot');
    if (card) toggleSpot(card.dataset.id);
  });
  $('#btnClassic').addEventListener('click', () => {
    const list = POIS[state.to.name] || [];
    if (!list.length) return toast('该城市暂无景点数据');
    const top4 = list.slice().sort((a, b) => b.satisfaction - a.satisfaction).slice(0, 4);
    state.selected = top4.map(p => p.id);
    renderSpots();
    refreshSpotMarkers();
    toast('已选入 4 个最高人气景点，可再手动增减');
  });
  $('#btnPlan').addEventListener('click', async () => {
    if (!state.selected.length) return toast('请先至少选择 1 个景点');
    const btn = $('#btnPlan');
    if (btn.disabled) return;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = MAPS.available() ? '正在获取景点出入口坐标…' : '正在生成行程…';
    try {
      await ensureSpotNav();  // 用百度 navi_location 把景点坐标换成真实出入口
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
    computeSchemes();
    gotoStep(4);
    applyScheme('recommended');
  });

  // 步骤 4
  $('#schemeTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-scheme]');
    if (b) applyScheme(b.dataset.scheme);
  });
  $('#chkTicket').addEventListener('change', e => {
    state.withTicket = e.target.checked;
    renderTimeline();
  });
  $$('.preset-row [data-preset]').forEach(btn => btn.addEventListener('click', () => {
    const p = btn.dataset.preset;
    if (p === 'smart') {
      // 最快组合：逐段对比百度实测时长，允许每段使用不同交通方式
      applyFastestModes(btn).catch(err => toast(`最快组合计算失败：${err && err.message ? err.message : err}`));
      return;
    }
    fastestToken++;  // 取消在途的最快组合
    resetFastestButton();
    state.modes = state.modes.map(() => p);
    renderTimeline();
    drawRoute(false);
  }));
  $('#timeline').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (chip) {
      state.modes[+chip.dataset.leg] = chip.dataset.mode;
      renderTimeline();
      drawRoute(false);
      return;
    }
    const navic = e.target.closest('.navic');
    if (navic) {
      const ep = icLegEndpoints(navic.dataset.navic);
      if (ep) window.open(baiduNav(ep[0], ep[1], 'driving', ep[2]), '_blank');
      return;
    }
    const navleg = e.target.closest('.navleg');
    if (navleg) {
      const ep = legEndpoints(+navleg.dataset.leg);
      if (ep) window.open(baiduNav(ep[0], ep[1], NAV_MODE[state.modes[+navleg.dataset.leg]] || 'driving'), '_blank');
      return;
    }
    const navspot = e.target.closest('.navspot');
    if (navspot) {
      const ep = legEndpoints(+navspot.dataset.leg);
      if (ep) window.open(baiduNav(ep[0], ep[1], NAV_MODE[state.modes[+navspot.dataset.leg]] || 'driving'), '_blank');
      return;
    }
    const mv = e.target.closest('.mv[data-mv]');
    if (mv) {
      const d = +mv.dataset.day, i = +mv.dataset.i;
      const order = state.orders.custom;
      const j = mv.dataset.mv === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < order[d].length) {
        [order[d][i], order[d][j]] = [order[d][j], order[d][i]];
        initModes();
        renderTimeline();
        drawRoute(true);
      }
      return;
    }
    const dm = e.target.closest('.mv[data-daymove]');
    if (dm) {
      const d = +dm.dataset.day, i = +dm.dataset.i;
      const dir = dm.dataset.daymove;
      const order = state.orders.custom;
      const s = order[d].splice(i, 1)[0];
      if (dir === 'prev') order[d - 1].push(s); else order[d + 1].unshift(s);
      initModes();
      renderTimeline();
      drawRoute(true);
    }
  });
  $('#btnCopy').addEventListener('click', copyItinerary);
  $('#btnTo5').addEventListener('click', () => gotoStep(5));

  // 步骤 5
  $('#btnNavAll').addEventListener('click', () => {
    // 全程导航：住宿地 → 最后一站（百度 URI API 不支持途经点，逐段导航用时间轴上的 🧭）
    const order = getOrder();
    const hub = hubOf(state.to);
    if (!order.flat().length) return toast('请先生成行程');
    const seq = [hub];
    order.forEach(dayIds => dayIds.forEach(id => seq.push(POIMAP[id])));
    window.open(baiduNav(seq[0], seq[seq.length - 1], 'driving'), '_blank');
  });

  // 返回按钮 + 步骤条（注意：弹窗关闭按钮不带 data-goto，不会误触）
  $$('.back[data-goto]').forEach(b => b.addEventListener('click', () => gotoStep(+b.dataset.goto)));
  $('#stepper').addEventListener('click', e => {
    const li = e.target.closest('li.can');
    if (li) gotoStep(+li.dataset.step);
  });

  // 地图工具
  $('#btnFitSpots').addEventListener('click', () => waitMap(() => { showSpots(true); }));
  $('#btnFitRoute').addEventListener('click', () => waitMap(() => drawRoute(true)));

  // 出发点（从哪出发去车站）：常用地点快捷键 + 模糊搜索候选 + 清除
  $('#btnDepartSearch').addEventListener('click', searchDepartPoints);
  $('#departPointInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchDepartPoints(); }
  });
  $('#departPointInput').addEventListener('input', () => {
    clearTimeout(departDebounce);
    const q = $('#departPointInput').value.trim();
    if (q.length < 2) { $('#departPointResults').classList.add('hidden'); return; }
    departDebounce = setTimeout(searchDepartPoints, 500);
  });
  $('#departPointQuick').addEventListener('click', e => {
    const b = e.target.closest('button[data-depart]');
    if (!b) return;
    if (b.dataset.depart === 'default') { clearDepartPoint(); return; }
    const m = departLandmarks()[+b.dataset.depart.slice(1)];
    if (!m) return;
    departSeq++;
    state.departPoint = { name: m[0], lng: m[1], lat: m[2] }; // CITY_LANDMARKS 行格式：[名称, 经度, 纬度]
    $('#departPointResults').classList.add('hidden');
    refreshDepartPointUI();
    onDepartPointChange();
  });
  $('#departPointResults').addEventListener('click', e => {
    if (e.target.closest('[data-depart-retry]')) { searchDepartPoints(); return; }
    const b = e.target.closest('[data-depart-item]');
    if (!b || b.disabled) return;
    const p = ($('#departPointResults')._places || [])[+b.dataset.departItem];
    if (p) applyDepartCandidate(p, b).catch(err => toast(`选用出发点失败：${err && err.message ? err.message : err}`));
  });
  $('#departPointPicked').addEventListener('click', e => {
    if (e.target.closest('[data-depart-clear]')) clearDepartPoint();
  });
  $('#accessBar').addEventListener('click', e => {
    const chip = e.target.closest('.st-chip');
    if (!chip || !state.transport) return;
    const side = chip.dataset.side || 'from';
    if (chip.dataset.stationClear) { clearStation(side); return; }
    const st = stationCandidates(side).find(s => s.name === chip.dataset.stationPick);
    if (!st) return;
    if (st.lng == null || st.lat == null) {
      applyStationCandidate(side, st, chip).catch(err => toast(`选择站点失败：${err && err.message ? err.message : err}`));
      return;
    }
    state.boardStations[side + ':' + state.transport.id] = { ...st, custom: true };
    refreshStationUI();
  });

  // 城际车站 / 机场：两侧都能模糊搜索并手选
  ['from', 'to'].forEach(side => {
    const cap = side === 'from' ? 'From' : 'To';
    const btn = $(`#btn${cap}StationSearch`);
    const input = $(`#${side}StationInput`);
    const chips = $(`#${side}StationChips`);
    const results = $(`#${side}StationResults`);
    if (btn) btn.addEventListener('click', () => searchStations(side));
    if (input) {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); searchStations(side); }
      });
      input.addEventListener('input', () => {
        clearTimeout(stationTimer[side]);
        const q = input.value.trim();
        if (q.length < 2) {
          if (results) results.classList.add('hidden');
          return;
        }
        stationTimer[side] = setTimeout(() => searchStations(side), 500);
      });
    }
    if (chips) chips.addEventListener('click', e => {
      const b = e.target.closest('button[data-station-pick]');
      if (!b) return;
      if (b.dataset.stationPick === '-1') { clearStation(side); return; }
      const items = chips._items || [];
      const st = items[+b.dataset.stationPick];
      if (st) applyStationCandidate(side, st, b).catch(err => toast(`选择站点失败：${err && err.message ? err.message : err}`));
    });
    if (results) results.addEventListener('click', e => {
      const b = e.target.closest('[data-station-item]');
      if (!b || b.disabled) return;
      const items = results._items || [];
      const st = items[+b.dataset.stationItem];
      if (st) applyStationCandidate(side, st, b).catch(err => toast(`选择站点失败：${err && err.message ? err.message : err}`));
    });
  });

  // 步骤 3：目的地情报
  $('#btnGuide').addEventListener('click', () => {
    const p = $('#guidePanel');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) renderGuide();
  });
  $('#guideTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-gtab]');
    if (!b) return;
    state.guideTab = b.dataset.gtab;
    renderGuide();
  });
  $('#guideSearch').addEventListener('input', renderGuide);
  $('#guideGen').addEventListener('click', aiGenGuide);
  $('#btnGuideAsk').addEventListener('click', guideAsk);
  $('#guideQ').addEventListener('keydown', e => { if (e.key === 'Enter') guideAsk(); });

  // AI 设置 / 输出弹窗
  $('#btnAiSet').addEventListener('click', openAiSettings);
  $('#cacheSave').addEventListener('click', saveCacheConfig);
  $('#aiProvider').addEventListener('change', () => {
    const p = AI_PROVIDERS[$('#aiProvider').value];
    $('#aiBaseURL').value = p.baseURL || '';
    $('#aiModel').value = p.model || '';
    $('#aiProviderHint').textContent = p.hint;
    $('#aiRealFields').classList.toggle('hidden', p === AI_PROVIDERS.demo);
  });
  $('#aiSave').addEventListener('click', () => {
    const provider = $('#aiProvider').value;
    AI.cfg = {
      provider,
      // 演示模式不存凭据：清掉残留，杜绝"看起来配好了实际是演示"的误导
      baseURL: provider === 'demo' ? '' : $('#aiBaseURL').value.trim(),
      model: provider === 'demo' ? '' : $('#aiModel').value.trim(),
      key: provider === 'demo' ? '' : $('#aiKey').value.trim(),
    };
    AI.save();
    const browserAkChanged = BAIDU.browserKey !== $('#baiduAkBrowser').value.trim();
    BAIDU.key = $('#baiduAk').value.trim();
    BAIDU.browserKey = $('#baiduAkBrowser').value.trim();
    BAIDU.save();
    // 高级分流：按能力指定供应商；任一项非 auto 时，工具栏显示「自定义」
    const beforePrefs = JSON.stringify(MAPS.prefs);
    MAPS.prefs = {
      route: $('#routeProviderPref').value,
      place: $('#placeProviderPref').value,
    };
    MAPS.savePrefs();
    updateProviderButton();
    if (JSON.stringify(MAPS.prefs) !== beforePrefs) {
      routeEst.clear();
      osrmCache.clear();
    }
    $('#aiModal').classList.add('hidden');
    updateAiBadge();
    if (browserAkChanged && BAIDU.browserKey) {
      toast('浏览器端 AK 已保存，刷新页面后底图切换为百度地图');
    } else if (MAPS.isCustom()) {
      toast(`已按能力分流：路线→${MAPS.label(MAPS.prefs.route) || '自动'}，地点→${MAPS.label(MAPS.prefs.place) || '自动'}`);
    } else {
      toast(provider === 'demo' ? '已切换为离线演示模式（不联网）' : '配置已保存到本机浏览器');
    }
    if (MAPS.available()) ensureRoutes(); // 新 AK 立刻升级路网估算
  });
  $('#aiTest').addEventListener('click', testAi);
  $$('#aiModal [data-close], #aiOut [data-close]').forEach(b =>
    b.addEventListener('click', () => b.closest('.modal').classList.add('hidden')));
  // 点遮罩关闭：按下与松开都在遮罩上才算。在输入框里拖选/长按文字时手指滑出
  // 边界、click 落在遮罩上（手机全选 API key 时高发），不能把弹窗关掉。
  $$('.modal').forEach(m => {
    m.addEventListener('pointerdown', e => { m._downOnBackdrop = (e.target === m); });
    m.addEventListener('click', e => {
      if (e.target === m && m._downOnBackdrop) m.classList.add('hidden');
    });
  });

  // AI 讲解 / 一句话规划
  $('#btnExplain').addEventListener('click', aiExplain);
  $('#btnNL').addEventListener('click', aiNLPlan);
  $('#nlInput').addEventListener('keydown', e => { if (e.key === 'Enter') aiNLPlan(); });
}

function updateAiBadge() {
  const b = $('#aiBadge');
  if (!b) return;
  const names = { openrouter: 'OpenRouter', deepseek: 'DeepSeek', siliconflow: 'SiliconFlow', huaweimaas: '华为云 MaaS', demo: '离线演示' };
  b.textContent = `✨ AI · ${names[AI.cfg.provider] || AI.cfg.provider}${AI.ready() ? '' : '（未配置）'}`;
}

/* ================= 路网供应商一键切换 =================
 * 两家开放平台都按秒限流，单家额度也有限。这里让用户（或现场演示）一键在
 * 自动 / 百度 / 高德 之间切换，切换后立刻重新探测并按新供应商拉一遍路网。 */

function updateProviderButton() {
  const btn = $('#btnProvider');
  if (!btn) return;
  const name = MAPS.isCustom()
    ? '自定义'
    : (MAPS.provider === 'auto' ? '自动' : MAPS.label(MAPS.provider));
  btn.textContent = '路网：' + name;
  btn.title = MAPS.statusText();
}

function initProviderSwitch() {
  const btn = $('#btnProvider');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (MAPS.isCustom()) {        // 高级设置生效时，点按直接进设置调整分流
      openAiSettings();
      return;
    }
    MAPS.cycle();
    updateProviderButton();
    await MAPS.probe();
    updateProviderButton();
    if (!MAPS.available()) {
      toast('这一家还没配置 key：先在环境变量或设置面板里填上');
      return;
    }
    routeEst.clear();          // 换供应商后旧里程作废，重新拉
    osrmCache.clear();
    ensureRoutes();
    if (state.step >= 4) { renderTimeline(); drawRoute(false); }
    const name = MAPS.provider === 'auto' ? '自动分流' : MAPS.label(MAPS.provider);
    toast(`路网已切到 ${name}${MAPS.provider === 'amap' ? '，刷新后底图也换成高德' : ''}`);
  });
  updateProviderButton();
}

/* ================= 启动 ================= */

bind();
initProviderSwitch();
gotoStep(1);
updateAiBadge();
AI.probeServer().then(updateAiBadge); // 检测本地 serve.py 代理是否在线
MAPS.probe().then(() => { // 地图服务就绪时，把估算升级为真实路网
  updateProviderButton();
  if (MAPS.available() && state.step >= 2) ensureRoutes();
});
