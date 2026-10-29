/* 跨城出行规划 · 页面逻辑
 * 数据在 travel-data.js（全国地级行政区 + 41 个城市分级景点，示意数据）；
 * 交通时长、价格按距离估算；接真实 API 时替换 intercityOptions / legOpts 即可。
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

/* POI：id = 「景点名@城市」，成都用引擎同源 id */
const POIS = {};   // 城市名 -> [poi]
const POIMAP = {}; // 全局 id -> poi
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

function hav(a, b) { // 两点球面距离，km
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
  date: '',
  transport: null,
  intercity: null,
  selected: [],
  orders: {},
  scheme: 'recommended',
  modes: [],
  closed: true,
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

/* ================= 方案渲染 ================= */

function getOrder() { return state.orders[state.scheme] || []; }

function seqPoints() {
  const hub = hubOf(state.to);
  const seq = [hub, ...getOrder().map(id => POIMAP[id])];
  if (state.closed && getOrder().length) seq.push(hub);
  return seq;
}

function initModes() {
  const seq = seqPoints();
  state.modes = [];
  for (let i = 1; i < seq.length; i++) {
    state.modes.push(smartMode(roadKm(seq[i - 1], seq[i])));
  }
}

function computeTotals() {
  const seq = seqPoints();
  let moveMin = 0, moveCost = 0, km = 0;
  for (let i = 1; i < seq.length; i++) {
    const d = roadKm(seq[i - 1], seq[i]);
    km += d;
    const opts = legOpts(d);
    const o = opts.find(x => x.id === state.modes[i - 1]) || opts[opts.length - 1];
    moveMin += o.min; moveCost += o.cost;
  }
  const order = getOrder();
  let playMin = 0, ticket = 0;
  order.forEach(id => { playMin += POIMAP[id].suggest_min; ticket += POIMAP[id].ticket; });
  const ic = state.transport || { min: 0, cost: 0 };
  return {
    moveMin, moveCost, km,
    playMin, ticket: state.withTicket ? ticket : 0,
    totalMin: ic.min + moveMin + playMin,
    totalCost: ic.cost + moveCost + (state.withTicket ? ticket : 0),
  };
}

function schemeMetaText() {
  const t = computeTotals();
  const alg = state.scheme === 'recommended'
    ? (getOrder().length <= 8 ? '全排列枚举出最优顺序' : '贪心 + 2-opt 近优解')
    : state.scheme === 'popular' ? '按「人气 ÷ 就近」启发式，多数游客的经典走法' : '手动调整顺序';
  return `${alg} · 市内通勤 ${fmtDur(t.moveMin)} / ${fmtKm(t.km)} · 游玩 ${fmtDur(t.playMin)}`;
}

function renderTimeline() {
  const seq = seqPoints();
  const order = getOrder();
  let h = '';
  seq.forEach((p, i) => {
    if (i > 0) {
      const km = roadKm(seq[i - 1], p);
      const opts = legOpts(km);
      h += `<div class="tleg"><div class="lbl">第 ${i} 段 · 约 ${fmtKm(km)}</div><div class="modes">`
        + opts.map(o => `<button class="chip c-${o.id}${state.modes[i - 1] === o.id ? ' on' : ''}" data-leg="${i - 1}" data-mode="${o.id}">`
          + `${o.icon} ${o.name} ${fmtDur(o.min)}${o.cost ? ` <span class="c-cost">¥${Math.round(o.cost)}</span>` : ''}</button>`).join('')
        + `<button class="mini navleg" data-leg="${i - 1}">🧭 导航</button></div></div>`;
    }
    if (p.isHub) {
      const first = i === 0;
      h += `<div class="tnode hub"><span class="dot"></span><div class="t-title">
        <span class="t-name">🏨 ${first ? p.name : '返回住宿地'}</span>
        <span class="t-sub">${first ? '城际抵达后从这里出发' : ''}</span></div></div>`;
    } else {
      const idx = order.indexOf(p.id) + 1;
      const canMove = state.scheme === 'custom';
      const up = canMove && idx > 1 ? `<button class="mv" data-mv="up" data-i="${idx - 1}">↑</button>` : '';
      const dn = canMove && idx < order.length ? `<button class="mv" data-mv="down" data-i="${idx - 1}">↓</button>` : '';
      h += `<div class="tnode"><span class="dot"></span><div class="t-title">
        <span class="t-num">${idx}</span><span class="t-name">${p.name}</span>
        <span class="t-sub">游玩约 ${fmtDur(p.suggest_min)} · ${p.ticket ? '门票 ¥' + p.ticket : '免费'}</span>
        ${up}${dn}<button class="mini navspot" data-i="${idx - 1}">🧭</button></div></div>`;
    }
  });
  $('#timeline').innerHTML = h;
  $('#schemeMeta').textContent = schemeMetaText();

  const t = computeTotals();
  const ic = state.transport;
  $('#totals').innerHTML = `
    ${ic ? `<span class="t">城际 ${ic.icon} ${fmtDur(ic.min)} · ${fmtCost(ic.cost)}</span>` : ''}
    <span class="t">市内通勤 <b>${fmtDur(t.moveMin)}</b> · ${fmtCost(t.moveCost)}</span>
    <span class="t">游玩 <b>${fmtDur(t.playMin)}</b></span>
    ${t.ticket ? `<span class="t">门票 ${fmtCost(t.ticket)}</span>` : ''}
    <span class="t total">全程约 <b>${fmtDur(t.totalMin)}</b> · 合计 ${fmtCost(t.totalCost)}</span>`;
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
  // 地图上至少标出市中心
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
  $('#selInfo').textContent = `已选 ${n} 个 · 游玩约 ${fmtDur(play)}` + (n > 8 ? ' · 偏多，建议分两天' : '');
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

function waitMap(cb, tries = 40) { // bootcdn 失败时等待 unpkg 回退脚本加载
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

function drawRoute(fit) {
  if (!map) return;
  gRoute.clearLayers();
  if (state.step < 4 || !state.selected.length) return;
  const seq = seqPoints();
  if (seq.length < 2) return;
  seq.forEach((p, i) => {
    if (p.isHub) {
      L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: 'pin-wrap', html: '<div class="pin hub">🏨</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
        zIndexOffset: 500,
      }).bindPopup(`<b>${p.name}</b><br>住宿 / 出发点`).addTo(gRoute);
      return;
    }
    const idx = getOrder().indexOf(p.id) + 1;
    L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: 'pin-wrap', html: `<div class="pin">${idx}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      zIndexOffset: 500,
    }).bindPopup(`<b>${idx}. ${p.name}</b><br>游玩约 ${fmtDur(p.suggest_min)} · ${p.ticket ? '门票 ¥' + p.ticket : '免费'}`).addTo(gRoute);
  });
  for (let i = 1; i < seq.length; i++) {
    const km = roadKm(seq[i - 1], seq[i]);
    const opts = legOpts(km);
    const chosen = opts.find(x => x.id === state.modes[i - 1]) || opts[opts.length - 1];
    const st = MODE_STYLE[chosen.id];
    const url = amapNav(seq[i - 1], seq[i], NAV_MODE[chosen.id]);
    L.polyline([[seq[i - 1].lat, seq[i - 1].lng], [seq[i].lat, seq[i].lng]],
      { color: st.c, weight: 4, opacity: 0.85, dashArray: st.d })
      .bindPopup(`<b>第 ${i} 段 · ${chosen.name}</b><br>约 ${fmtDur(chosen.min)} · ${fmtCost(chosen.cost)} · ${fmtKm(km)}<br><a class="pop-nav" target="_blank" rel="noopener" href="${url}">🧭 在高德地图打开该段导航</a>`)
      .addTo(gRoute);
  }
  if (fit) fitPts(seq);
}

/* ================= 复制行程单 ================= */

function buildItineraryText() {
  const t = computeTotals();
  const seq = seqPoints();
  const ic = state.transport;
  const lines = [];
  lines.push(`【行程单】${state.from.name} → ${state.to.name}（${state.date || '待定'}）`);
  if (ic) lines.push(`城际：${ic.name} 约 ${fmtDur(ic.min)} · ${fmtCost(ic.cost)}`);
  seq.forEach((p, i) => {
    if (i > 0) {
      const km = roadKm(seq[i - 1], p);
      const o = legOpts(km).find(x => x.id === state.modes[i - 1]);
      if (o) lines.push(`  ├ ${o.name}约 ${fmtDur(o.min)}${o.cost ? `（¥${Math.round(o.cost)}）` : ''}`);
    }
    if (p.isHub) {
      lines.push(`${i === 0 ? '● ' + p.name : '● 返回住宿地'}`);
    } else {
      const idx = getOrder().indexOf(p.id) + 1;
      lines.push(`${idx}. ${p.name}　游玩约 ${fmtDur(p.suggest_min)}${p.ticket ? `　门票 ¥${p.ticket}` : ''}`);
    }
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
    '选择出发地与目的地（全国地级市），点「查询交通方式」',
    '两地位置与交通对比；地图上可先看目的地景点分布',
    '地图即景点分布：点圆点或左侧卡片勾选景点，可按分类筛选',
    '路线已画出：颜色对应通勤方式，点线段可跳转导航',
    '点任意线段或图钉，可在高德地图中打开导航',
  ][n - 1];
  if (n === 2) showIntercity();
  if (n === 3) showSpots(false);
  if (n >= 4) drawRoute(true);
}

/* ================= 查询与方案 ================= */

function doQuery() {
  state.date = $('#dateInp').value;
  state.transport = null;
  state.selected = [];
  state.spotTier = 'all';
  state.intercity = intercityOptions(state.from, state.to);
  renderTransport();
  $('#btnTo3').disabled = true;
  waitMap(() => { showIntercity(); showSpots(false); });
  gotoStep(2);
}

function buildOrders() {
  const hub = hubOf(state.to);
  const spots = state.selected.map(id => POIMAP[id]);
  state.orders.recommended = optimalOrder(spots, hub, state.closed);
  state.orders.popular = popularOrder(spots, hub);
  state.orders.custom = [...state.orders.recommended];
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
  $('#dateInp').value = new Date().toISOString().slice(0, 10);

  $('#btnSwap').addEventListener('click', () => {
    const f = $('#fromSel').value;
    $('#fromSel').value = $('#toSel').value;
    $('#toSel').value = f;
  });

  // 热门目的地快捷键
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
    buildOrders();
    gotoStep(4);
    applyScheme('recommended');
  });

  // 步骤 4
  $('#schemeTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-scheme]');
    if (b) applyScheme(b.dataset.scheme);
  });
  $('#chkClosed').addEventListener('change', e => {
    state.closed = e.target.checked;
    buildOrders();
    initModes();
    renderTimeline();
    drawRoute(true);
  });
  $('#chkTicket').addEventListener('change', e => {
    state.withTicket = e.target.checked;
    renderTimeline();
  });
  $$('.preset-row [data-preset]').forEach(btn => btn.addEventListener('click', () => {
    const p = btn.dataset.preset;
    state.modes = state.modes.map((_, i) => {
      if (p !== 'smart') return p;
      const seq = seqPoints();
      return smartMode(roadKm(seq[i], seq[i + 1]));
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
      const seq = seqPoints();
      const i = +navleg.dataset.leg;
      window.open(amapNav(seq[i], seq[i + 1], NAV_MODE[state.modes[i]] || 'car'), '_blank');
      return;
    }
    const navspot = e.target.closest('.navspot');
    if (navspot) {
      const seq = seqPoints();
      const idx = +navspot.dataset.i;
      const i = idx + 1;
      window.open(amapNav(seq[i - 1], seq[i], NAV_MODE[state.modes[i - 1]] || 'car'), '_blank');
      return;
    }
    const mv = e.target.closest('.mv');
    if (mv) {
      const i = +mv.dataset.i, order = state.orders.custom;
      const j = mv.dataset.mv === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < order.length) {
        [order[i], order[j]] = [order[j], order[i]];
        state.modes = state.modes.map((_, k) => {
          const seq = seqPoints();
          return smartMode(roadKm(seq[k], seq[k + 1]));
        });
        renderTimeline();
        drawRoute(true);
      }
    }
  });
  $('#btnCopy').addEventListener('click', copyItinerary);
  $('#btnTo5').addEventListener('click', () => gotoStep(5));

  // 步骤 5
  $('#btnNavAll').addEventListener('click', () => {
    const seq = seqPoints();
    if (seq.length < 2) return toast('请先生成行程');
    const via = seq.slice(1, -1).map(p => `${p.lng},${p.lat}`).join(';');
    const pp = p => `${p.lng},${p.lat},${encodeURIComponent(p.name || '')}`;
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
