/* 跨城出行规划 · 页面逻辑（时间段 + 分天安排版）
 * 数据在 travel-data.js（全国地级行政区 + 41 城分级景点，示意数据）；
 * 城际交通与市内通勤按距离估算，接真实 API 时替换 intercityOptions / legOpts。
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
};

function hubOf(c) {
  const h = HUBS[c.name];
  if (h) return { name: h[0], lat: h[1], lng: h[2], isHub: true };
  return { name: '市中心（默认住宿）', lat: c.lat, lng: c.lng, isHub: true };
}

/* ================= 行程窗口 ================= */

// 去程推算：出发时刻 + 城际时长；跨天则第 1 天按晚间自由活动处理
function arrivalInfo() {
  const dep = toMin(state.departTime);
  if (dep == null || !state.transport) return { spill: 0, arriveMin: null };
  const total = dep + state.transport.min;
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
    return `<button class="tcard${state.transport && state.transport.id === o.id ? ' on' : ''}" data-id="${o.id}">
      ${badges.join('')}
      <span class="ico">${o.icon}</span>
      <span><span class="name">${o.name}</span><span class="note">${o.note}</span></span>
      <span><span class="time">${fmtDur(o.min)}</span><span class="cost" style="display:block">${fmtCost(o.cost)}</span></span>
    </button>`;
  }).join('');
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

function initModes() {
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
      km += d;
      const opts = legOpts(d);
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
  return {
    perDay,
    moveMin: sum('moveMin'), moveCost: sum('moveCost'), km: sum('km'),
    playMin, ticket: state.withTicket ? ticket : 0,
    totalMin: ic.min + sum('moveMin') + playMin,
    totalCost: ic.cost + sum('moveCost') + (state.withTicket ? ticket : 0),
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
        ? `${a.spill > 0 ? '+' + a.spill + ' 天 ' : ''}${fmtHM(a.arriveMin)} 抵达`
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

function renderTimeline() {
  const order = getOrder();
  const hub = hubOf(state.to);
  const t = computeTotals();
  const custom = state.scheme === 'custom';
  let legIdx = 0, h = '';
  order.forEach((dayIds, di) => {
    const pd = t.perDay[di];
    h += `<div class="day-block"><div class="day-head"><span class="d-num">第 ${di + 1} 天</span>`
      + `<span class="d-date">${fmtDateCN(state.days[di])}</span>`
      + `<span class="d-sub">通勤 ${fmtDur(pd.moveMin)} · 游玩 ${fmtDur(pd.playMin)}</span>`
      + (pd.warn ? `<span class="d-warn">⚠ 超出时间窗约 ${fmtDur(pd.warn)}</span>` : '')
      + `</div><div class="day-body">`;
    if (!dayIds.length) {
      h += `<div class="t-rest">🌿 这一天自由活动，可在「自定义安排」里把景点挪过来</div></div></div>`;
      return;
    }
    const seq = [hub, ...dayIds.map(id => POIMAP[id]), hub];
    seq.forEach((p, k) => {
      if (k > 0) {
        const km = roadKm(seq[k - 1], p);
        const opts = legOpts(km);
        h += `<div class="tleg"><div class="lbl">第 ${di + 1} 天 · 段 ${k} · 约 ${fmtKm(km)}</div><div class="modes">`
          + opts.map(o => `<button class="chip c-${o.id}${state.modes[legIdx] === o.id ? ' on' : ''}" data-leg="${legIdx}" data-mode="${o.id}">`
            + `${o.icon} ${o.name} ${fmtDur(o.min)}${o.cost ? ` <span class="c-cost">¥${Math.round(o.cost)}</span>` : ''}</button>`).join('')
          + `<button class="mini navleg" data-leg="${legIdx}">🧭 导航</button></div></div>`;
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

  $('#totals').innerHTML = `
    ${ic2Row()}
    <span class="t">市内通勤 <b>${fmtDur(t.moveMin)}</b> · ${fmtCost(t.moveCost)}</span>
    <span class="t">游玩 <b>${fmtDur(t.playMin)}</b></span>
    ${t.ticket ? `<span class="t">门票 ${fmtCost(t.ticket)}</span>` : ''}
    <span class="t total">全程约 <b>${fmtDur(t.totalMin)}</b> · 合计 ${fmtCost(t.totalCost)}</span>`;
}
function ic2Row() {
  const ic = state.transport;
  return ic ? `<span class="t">城际 ${ic.icon} ${fmtDur(ic.min)} · ${fmtCost(ic.cost)}</span>` : '';
}

/* ================= 景点选择 ================= */

function tierLabel(t) { return TIERS[t] ? TIERS[t].label : ''; }

function renderSpots() {
  const list = POIS[state.to.name] || [];
  $('#destName').textContent = state.to.name;

  if (!list.length) return renderNotCovered();

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

function renderNotCovered() {
  $('#tierFilter').classList.add('hidden');
  $('#selInfo').textContent = '已选 0 个';
  const hub = hubOf(state.to);
  const near = CURATED_CITIES
    .map(c => ({ c, km: hav(state.to, c) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 3);
  $('#spotGrid').innerHTML = `
    <div class="notice">
      <h3>🧭 「${state.to.name}」的景点数据待收录</h3>
      <p>本原型深度收录了 ${CURATED_CITIES.length} 个城市（四级分类：热门 / 性价比 / 冷门 / 待探索），
      其余地级市可正常作为出发地与目的地查询交通，但暂不能生成市内行程。</p>
      <p class="muted">这对应数据源矩阵里「POI 需人工录入 + 标注来源」的现实约束；接入地图开放平台 POI 检索后即可自动覆盖。</p>
      <p class="near-label">附近已收录的城市：</p>
      <div class="near-list">
        ${near.map(n => `<button class="ghost-btn" data-goto-city="${n.c.name}">${n.c.name} · ${Math.round(n.km)} km</button>`).join('')}
      </div>
    </div>`;
  if (map && gSpots) {
    gSpots.clearLayers();
    Object.keys(spotMarkers).forEach(k => delete spotMarkers[k]);
    L.circleMarker([state.to.lat, state.to.lng], {
      radius: 8, color: '#fff', weight: 2, fillColor: '#a8671c', fillOpacity: 0.95,
    }).addTo(gSpots).bindPopup(`<b>${state.to.name}</b><br>市中心（示意）`);
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
const spotMarkers = {};
const MODE_STYLE = {
  walk: { c: '#3d8b37', d: '2,7' },
  bike: { c: '#c07b12', d: '7,7' },
  transit: { c: '#2f6bb0', d: null },
  taxi: { c: '#6d4fa1', d: null },
};
const NAV_MODE = { walk: 'walk', bike: 'ride', transit: 'bus', taxi: 'car' };

function initMap() {
  if (map || typeof L === 'undefined') return false;
  map = L.map('map', { zoomControl: true });
  map.attributionControl.setPrefix(false);
  const gaode = L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    { subdomains: '1234', maxZoom: 18, attribution: '© 高德地图' });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  gaode.addTo(map);
  L.control.layers({ '高德地图': gaode, 'OpenStreetMap': osm }, {}, { position: 'topleft' }).addTo(map);
  gInter = L.layerGroup().addTo(map);
  gSpots = L.layerGroup().addTo(map);
  gRoute = L.layerGroup().addTo(map);
  map.setView([32.8, 112.0], 4);
  return true;
}

function waitMap(cb, tries = 40) {
  if (initMap()) { cb(); return; }
  if (tries <= 0) { toast('地图组件加载失败，请检查网络'); return; }
  setTimeout(() => waitMap(cb, tries - 1), 150);
}

function fitPts(pts) {
  if (!map || !pts.length) return;
  const b = L.latLngBounds(pts.map(p => [p.lat, p.lng]));
  map.fitBounds(b, { padding: [42, 42] });
}

function showIntercity() {
  if (!map) return;
  gInter.clearLayers();
  const a = state.from, b = state.to;
  L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: '#7a746b', weight: 2.5, dashArray: '6,8' })
    .bindPopup(`<b>${a.name} → ${b.name}</b><br>直线约 ${Math.round(hav(a, b))} km`)
    .addTo(gInter);
  [a, b].forEach((c) => {
    L.marker([c.lat, c.lng], {
      icon: L.divIcon({ className: 'pin-wrap', html: `<div class="pin city">${c.name}</div>`, iconSize: [40, 22], iconAnchor: [20, 11] }),
      zIndexOffset: 400,
    }).addTo(gInter);
  });
  fitPts([a, b]);
}

function refreshSpotMarkers() {
  if (!map) return;
  Object.keys(spotMarkers).forEach(id => {
    const on = state.selected.includes(id);
    spotMarkers[id].setStyle({ fillColor: on ? '#1f6b4f' : '#a8a093' });
  });
}

function showSpots(fit) {
  if (!map) return;
  gSpots.clearLayers();
  Object.keys(spotMarkers).forEach(k => delete spotMarkers[k]);
  const list = POIS[state.to.name] || [];
  if (!list.length) { renderNotCovered(); return; }
  list.forEach(p => {
    const m = L.circleMarker([p.lat, p.lng], {
      radius: 7, color: '#fff', weight: 2,
      fillColor: state.selected.includes(p.id) ? '#1f6b4f' : '#a8a093', fillOpacity: 0.95,
    }).addTo(gSpots);
    m.bindPopup(`<b>${p.name}</b><br>${tierLabel(p.tier)} · ${p.ticket ? '门票 ¥' + p.ticket : '免费'} · 建议玩 ${fmtDur(p.suggest_min)}<br>${p.note || ''}`);
    m.on('click', () => { if (state.step === 3) toggleSpot(p.id); });
    spotMarkers[p.id] = m;
  });
  if (fit) fitPts(list);
}

function amapNav(fromPt, toPt, mode) {
  const pp = pt => `${pt.lng},${pt.lat},${encodeURIComponent(pt.name || '')}`;
  return `https://uri.amap.com/navigation?from=${pp(fromPt)}&to=${pp(toPt)}&mode=${mode}&policy=1&src=trip_planner_demo&coordinate=gaode&callnative=0`;
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

function drawRoute(fit) {
  if (!map) return;
  gRoute.clearLayers();
  if (state.step < 4 || !state.selected.length) return;
  const order = getOrder();
  if (!order.flat().length) return;
  const hub = hubOf(state.to);
  const allPts = [hub];
  L.marker([hub.lat, hub.lng], {
    icon: L.divIcon({ className: 'pin-wrap', html: '<div class="pin hub">🏨</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
    zIndexOffset: 500,
  }).bindPopup(`<b>${hub.name}</b><br>住宿 / 出发点（全程同一酒店）`).addTo(gRoute);
  let legIdx = 0;
  order.forEach((dayIds, di) => {
    if (!dayIds.length) return; // 空天（自由活动）不画线不占段
    const seq = [hub, ...dayIds.map(id => POIMAP[id]), hub];
    seq.forEach((p, k) => {
      if (!p.isHub) allPts.push(p);
      if (k === 0) return;
      // 段
      const km = roadKm(seq[k - 1], seq[k]);
      const opts = legOpts(km);
      const chosen = opts.find(x => x.id === state.modes[legIdx]) || opts[opts.length - 1];
      const st = MODE_STYLE[chosen.id];
      const url = amapNav(seq[k - 1], seq[k], NAV_MODE[chosen.id]);
      L.polyline([[seq[k - 1].lat, seq[k - 1].lng], [seq[k].lat, seq[k].lng]],
        { color: st.c, weight: 4, opacity: 0.85, dashArray: st.d })
        .bindPopup(`<b>第 ${di + 1} 天 段 ${k} · ${chosen.name}</b><br>约 ${fmtDur(chosen.min)} · ${fmtCost(chosen.cost)} · ${fmtKm(km)}<br><a class="pop-nav" target="_blank" rel="noopener" href="${url}">🧭 在高德地图打开该段导航</a>`)
        .addTo(gRoute);
      legIdx++;
      // 图钉
      if (seq[k].isHub) return;
      L.marker([seq[k].lat, seq[k].lng], {
        icon: L.divIcon({ className: 'pin-wrap', html: `<div class="pin">${di + 1}·${k}</div>`, iconSize: [30, 26], iconAnchor: [15, 13] }),
        zIndexOffset: 500,
      }).bindPopup(`<b>第 ${di + 1} 天 第 ${k} 站 · ${seq[k].name}</b><br>游玩约 ${fmtDur(seq[k].suggest_min)} · ${seq[k].ticket ? '门票 ¥' + seq[k].ticket : '免费'}`).addTo(gRoute);
    });
  });
  if (fit) fitPts(allPts);
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
  if (ic) lines.push(`城际：${ic.name} 约 ${fmtDur(ic.min)} · ${fmtCost(ic.cost)}`);
  order.forEach((dayIds, di) => {
    lines.push(`── 第 ${di + 1} 天 · ${fmtDateCN(state.days[di])} ──`);
    if (!dayIds.length) { lines.push('（自由活动）'); return; }
    const seq = [hub, ...dayIds.map(id => POIMAP[id]), hub];
    seq.forEach((p, k) => {
      if (k > 0) {
        const km = roadKm(seq[k - 1], p);
        const opts = legOpts(km);
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
  lines.push(`市内通勤 ${fmtDur(t.moveMin)} / ${fmtKm(t.km)} · 门票 ${fmtCost(t.ticket)} · 全程约 ${fmtDur(t.totalMin)} · 合计 ${fmtCost(t.totalCost)}`);
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
  $('#legend').classList.toggle('hidden', n < 4);
  $('#mapHint').textContent = [
    '选择出发地与目的地（全国地级市）和时间段，点「查询交通方式」',
    '两地位置与交通对比；地图上可先看目的地景点分布',
    '地图即景点分布：点圆点或左侧卡片勾选景点，可按分类筛选',
    '行程按天分组：图钉 = 天·序号，颜色对应通勤方式，点线段可跳转导航',
    '点任意线段或图钉，可在高德地图中打开导航',
  ][n - 1];
  if (n === 2) showIntercity();
  if (n === 3) showSpots(false);
  if (n >= 4) drawRoute(true);
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
  state.intercity = intercityOptions(state.from, state.to);
  renderTransport();
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

/* ================= 事件绑定 ================= */

function fillCitySelect(sel, def) {
  sel.innerHTML = PROVINCE_CITIES.map(([province, list]) =>
    `<optgroup label="${province}">`
    + list.map(([name]) => `<option value="${name}">${name}</option>`).join('')
    + '</optgroup>').join('');
  sel.value = def;
}

function bind() {
  fillCitySelect($('#fromSel'), state.from.name);
  fillCitySelect($('#toSel'), state.to.name);
  const today = fmtISO(new Date());
  $('#arriveDate').value = today;
  $('#returnDate').value = addDaysStr(today, 2);
  updateTripHint();
  ['arriveDate', 'returnDate', 'departTime', 'returnTime'].forEach(id => {
    $('#' + id).addEventListener('change', updateTripHint);
  });

  $('#btnSwap').addEventListener('click', () => {
    const f = $('#fromSel').value;
    $('#fromSel').value = $('#toSel').value;
    $('#toSel').value = f;
  });

  $('#quickCities').addEventListener('click', e => {
    const b = e.target.closest('button[data-city]');
    if (!b) return;
    $('#toSel').value = b.dataset.city;
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
    renderTransport();
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
      state.to = CITYMAP[name];
      state.transport = null;
      state.selected = [];
      state.intercity = intercityOptions(state.from, state.to);
      renderTransport();
      $('#btnTo3').disabled = true;
      toast(`目的地改为「${name}」，请重新选择城际交通`);
      waitMap(() => { showIntercity(); showSpots(false); });
      gotoStep(2);
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
  $('#btnPlan').addEventListener('click', () => {
    if (!state.selected.length) return toast('请先至少选择 1 个景点');
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
    state.modes = state.modes.map((_, i) => {
      if (p !== 'smart') return p;
      const ep = legEndpoints(i);
      return smartMode(roadKm(ep[0], ep[1]));
    });
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
    const navleg = e.target.closest('.navleg');
    if (navleg) {
      const ep = legEndpoints(+navleg.dataset.leg);
      if (ep) window.open(amapNav(ep[0], ep[1], NAV_MODE[state.modes[+navleg.dataset.leg]] || 'car'), '_blank');
      return;
    }
    const navspot = e.target.closest('.navspot');
    if (navspot) {
      const ep = legEndpoints(+navspot.dataset.leg);
      if (ep) window.open(amapNav(ep[0], ep[1], NAV_MODE[state.modes[+navspot.dataset.leg]] || 'car'), '_blank');
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
    // 全程导航：第 1 天酒店出发，串完最后一天，以最后一段方式收尾
    const order = getOrder();
    const hub = hubOf(state.to);
    if (!order.flat().length) return toast('请先生成行程');
    const pp = p => `${p.lng},${p.lat},${encodeURIComponent(p.name || '')}`;
    const seq = [hub];
    order.forEach(dayIds => dayIds.forEach(id => seq.push(POIMAP[id])));
    const via = seq.slice(1, -1).map(p => `${p.lng},${p.lat}`).join(';');
    window.open(`https://uri.amap.com/navigation?from=${pp(seq[0])}&to=${pp(seq[seq.length - 1])}&via=${via}&mode=car&policy=1&src=trip_planner_demo&coordinate=gaode&callnative=0`, '_blank');
  });

  // 返回按钮 + 步骤条
  $$('.back').forEach(b => b.addEventListener('click', () => gotoStep(+b.dataset.goto)));
  $('#stepper').addEventListener('click', e => {
    const li = e.target.closest('li.can');
    if (li) gotoStep(+li.dataset.step);
  });

  // 地图工具
  $('#btnFitSpots').addEventListener('click', () => waitMap(() => { showSpots(true); }));
  $('#btnFitRoute').addEventListener('click', () => waitMap(() => drawRoute(true)));
}

/* ================= 启动 ================= */

bind();
gotoStep(1);
