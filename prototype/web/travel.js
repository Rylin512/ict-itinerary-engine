/* 跨城出行规划 · 前端原型
 * 数据全部为内置示意数据（成都景点与单城编排版共用一套坐标/票价）；
 * 交通时长、价格按距离估算；接入真实 API 时替换 intercityOptions / legOpts 两个函数即可。
 */
'use strict';

/* ================= 数据 ================= */

const CITIES = [
  { id: 'beijing',   name: '北京', lat: 39.904, lng: 116.407, hub: '酒店（前门·市中心）', hubLat: 39.899, hubLng: 116.398 },
  { id: 'shanghai',  name: '上海', lat: 31.230, lng: 121.474, hub: '酒店（人民广场）', hubLat: 31.232, hubLng: 121.474 },
  { id: 'xian',      name: '西安', lat: 34.342, lng: 108.940, hub: '酒店（钟楼）', hubLat: 34.261, hubLng: 108.943 },
  { id: 'chengdu',   name: '成都', lat: 30.572, lng: 104.067, hub: '酒店（春熙路）', hubLat: 30.6545, hubLng: 104.0800 },
  { id: 'hangzhou',  name: '杭州', lat: 30.274, lng: 120.155, hub: '酒店（湖滨·西湖东）', hubLat: 30.249, hubLng: 120.155 },
  { id: 'guangzhou', name: '广州', lat: 23.129, lng: 113.264, hub: '酒店（珠江新城）', hubLat: 23.119, hubLng: 113.321 },
];

/* 字段与 engine/data/chengdu_pois.json 对齐：id/name/lat/lng/ticket/suggest_min/satisfaction */
const POIS = {
  chengdu: [
    { id: 'kuanzhai', name: '宽窄巷子', lat: 30.6636, lng: 104.0556, category: '历史街区', tags: ['拍照', '小吃'], ticket: 0, suggest_min: 100, satisfaction: 0.92, note: '侧巷比主街安静，茶馆和小吃多' },
    { id: 'renmin', name: '人民公园', lat: 30.6608, lng: 104.0576, category: '公园', tags: ['茶馆', '休闲'], ticket: 0, suggest_min: 90, satisfaction: 0.85, note: '鹤鸣茶社适合歇脚，正好接午餐' },
    { id: 'tianfu', name: '天府广场', lat: 30.6570, lng: 104.0655, category: '地标', tags: ['地标'], ticket: 0, suggest_min: 30, satisfaction: 0.60, note: '顺路看一眼即可' },
    { id: 'chunxi', name: '春熙路·太古里', lat: 30.6538, lng: 104.0810, category: '商圈', tags: ['购物', '夜景'], ticket: 0, suggest_min: 90, satisfaction: 0.88, note: '太古里白天看建筑，晚上看灯光' },
    { id: 'cdmuseum', name: '成都博物馆', lat: 30.6570, lng: 104.0630, category: '博物馆', tags: ['历史', '需预约'], ticket: 0, suggest_min: 120, satisfaction: 0.90, note: '每周一闭馆，需提前预约' },
    { id: 'wenshu', name: '文殊院', lat: 30.6810, lng: 104.0710, category: '寺庙', tags: ['寺庙', '素斋'], ticket: 0, suggest_min: 60, satisfaction: 0.80, note: '旁边的素斋和甜水面值得排队' },
    { id: 'wuhou', name: '武侯祠', lat: 30.6455, lng: 104.0458, category: '历史', tags: ['三国', '园林'], ticket: 50, suggest_min: 100, satisfaction: 0.90, note: '红墙竹影是拍照点，正门进' },
    { id: 'jinli', name: '锦里', lat: 30.6437, lng: 104.0440, category: '街区', tags: ['小吃', '夜景'], ticket: 0, suggest_min: 90, satisfaction: 0.85, note: '紧挨武侯祠，可连着排' },
    { id: 'dufu', name: '杜甫草堂', lat: 30.6605, lng: 104.0288, category: '历史', tags: ['诗歌', '园林'], ticket: 50, suggest_min: 110, satisfaction: 0.88, note: '园林大，夏天遮阴好' },
    { id: 'jinsha', name: '金沙遗址博物馆', lat: 30.6830, lng: 104.0130, category: '博物馆', tags: ['考古', '室内'], ticket: 70, suggest_min: 120, satisfaction: 0.90, note: '每周一闭馆' },
    { id: 'panda', name: '大熊猫繁育研究基地', lat: 30.7327, lng: 104.1457, category: '动物园', tags: ['熊猫', '必去'], ticket: 55, suggest_min: 180, satisfaction: 0.98, note: '越早越好，9 点前熊猫最活跃，单独占半天' },
    { id: 'dongjiao', name: '东郊记忆', lat: 30.6720, lng: 104.1250, category: '文创园', tags: ['工业风', '拍照'], ticket: 0, suggest_min: 110, satisfaction: 0.80, note: '厂房改造，适合傍晚去，顺路吃饭' },
    { id: 'jiuyan', name: '九眼桥', lat: 30.6420, lng: 104.0870, category: '夜生活', tags: ['夜景', '江边'], ticket: 0, suggest_min: 90, satisfaction: 0.75, note: '晚上才热闹，白天去没意义' },
    { id: 'qingyang', name: '青羊宫', lat: 30.6650, lng: 104.0380, category: '道观', tags: ['道观', '清静'], ticket: 10, suggest_min: 60, satisfaction: 0.70, note: '离杜甫草堂不远，可顺路' },
  ],
  beijing: [
    { id: 'gugong', name: '故宫博物院', lat: 39.917, lng: 116.397, category: '历史', tags: ['世界遗产', '必去'], ticket: 60, suggest_min: 210, satisfaction: 0.97, note: '需提前预约，上午入宫人流最少' },
    { id: 'tiananmen', name: '天安门广场', lat: 39.903, lng: 116.397, category: '地标', tags: ['地标', '升旗'], ticket: 0, suggest_min: 60, satisfaction: 0.95, note: '看升旗要早起，广场需预约' },
    { id: 'summerpalace', name: '颐和园', lat: 39.999, lng: 116.273, category: '园林', tags: ['世界遗产', '皇家园林'], ticket: 30, suggest_min: 180, satisfaction: 0.92, note: '昆明湖东岸走完约 3 小时' },
    { id: 'greatwall', name: '八达岭长城', lat: 40.360, lng: 116.024, category: '历史', tags: ['世界遗产', '户外'], ticket: 40, suggest_min: 210, satisfaction: 0.94, note: '在郊区，单独占半天到一天' },
    { id: 'templeheaven', name: '天坛公园', lat: 39.882, lng: 116.411, category: '历史', tags: ['世界遗产', '公园'], ticket: 15, suggest_min: 90, satisfaction: 0.88, note: '祈年殿早上光线最好' },
    { id: 'nanluogu', name: '南锣鼓巷', lat: 39.941, lng: 116.403, category: '街区', tags: ['胡同', '小吃'], ticket: 0, suggest_min: 90, satisfaction: 0.82, note: '主街人多，支巷更有味道' },
    { id: 'shichahai', name: '什刹海', lat: 39.941, lng: 116.384, category: '街区', tags: ['胡同', '夜景'], ticket: 0, suggest_min: 90, satisfaction: 0.83, note: '傍晚环湖最好，可接南锣鼓巷' },
    { id: 'yonghegong', name: '雍和宫', lat: 39.948, lng: 116.418, category: '寺庙', tags: ['寺庙', '文化'], ticket: 25, suggest_min: 90, satisfaction: 0.85, note: '香火旺，门口可领香' },
    { id: 'olympic', name: '奥林匹克公园（鸟巢/水立方）', lat: 39.991, lng: 116.391, category: '地标', tags: ['地标', '夜景'], ticket: 0, suggest_min: 90, satisfaction: 0.80, note: '建议晚上看灯光' },
  ],
  shanghai: [
    { id: 'bund', name: '外滩', lat: 31.234, lng: 121.490, category: '地标', tags: ['夜景', '必去'], ticket: 0, suggest_min: 90, satisfaction: 0.96, note: '傍晚到亮灯之间最佳' },
    { id: 'orientaltv', name: '东方明珠', lat: 31.240, lng: 121.500, category: '地标', tags: ['观景', '亲子'], ticket: 199, suggest_min: 120, satisfaction: 0.90, note: '可与外滩隔江相望，二选一或都去' },
    { id: 'yuyuan', name: '豫园·城隍庙', lat: 31.227, lng: 121.492, category: '园林', tags: ['江南园林', '小吃'], ticket: 40, suggest_min: 90, satisfaction: 0.87, note: '九曲桥人最多，早上清静' },
    { id: 'nanjingrd', name: '南京路步行街', lat: 31.235, lng: 121.480, category: '商圈', tags: ['购物'], ticket: 0, suggest_min: 90, satisfaction: 0.88, note: '连接人民广场与外滩，顺路走' },
    { id: 'tianzifang', name: '田子坊', lat: 31.210, lng: 121.467, category: '街区', tags: ['文艺', '弄堂'], ticket: 0, suggest_min: 90, satisfaction: 0.80, note: '弄堂小店多，适合慢逛' },
    { id: 'disney', name: '上海迪士尼度假区', lat: 31.143, lng: 121.657, category: '乐园', tags: ['亲子', '一整天'], ticket: 475, suggest_min: 480, satisfaction: 0.95, note: '单独占一天，需早去' },
    { id: 'shmuseum', name: '上海博物馆', lat: 31.229, lng: 121.475, category: '博物馆', tags: ['历史', '免费'], ticket: 0, suggest_min: 120, satisfaction: 0.85, note: '青铜馆是镇馆看点' },
    { id: 'wukang', name: '武康路·衡复风貌区', lat: 31.207, lng: 121.438, category: '街区', tags: ['文艺', '建筑'], ticket: 0, suggest_min: 90, satisfaction: 0.78, note: '梧桐区 City Walk 起点之一' },
    { id: 'zhujiajiao', name: '朱家角古镇', lat: 31.111, lng: 121.054, category: '古镇', tags: ['水乡', '半日'], ticket: 60, suggest_min: 180, satisfaction: 0.82, note: '在郊区，往返要多留 3 小时' },
  ],
  xian: [
    { id: 'terracotta', name: '秦始皇帝陵博物院（兵马俑）', lat: 34.384, lng: 109.278, category: '历史', tags: ['世界遗产', '必去'], ticket: 120, suggest_min: 210, satisfaction: 0.97, note: '在临潼，市区过去单程约 1 小时' },
    { id: 'dayanta', name: '大雁塔', lat: 34.223, lng: 108.964, category: '历史', tags: ['地标', '喷泉'], ticket: 30, suggest_min: 90, satisfaction: 0.93, note: '北广场音乐喷泉晚上有场次' },
    { id: 'datang', name: '大唐不夜城', lat: 34.216, lng: 108.960, category: '街区', tags: ['夜景', '演出'], ticket: 0, suggest_min: 90, satisfaction: 0.90, note: '一定要晚上去，紧挨大雁塔' },
    { id: 'citywall', name: '西安城墙（永宁门）', lat: 34.259, lng: 108.934, category: '历史', tags: ['古城墙', '骑行'], ticket: 54, suggest_min: 120, satisfaction: 0.90, note: '城墙上可租自行车，环骑约 100 分钟' },
    { id: 'muslim', name: '回民街·北院门', lat: 34.265, lng: 108.937, category: '街区', tags: ['美食'], ticket: 0, suggest_min: 90, satisfaction: 0.82, note: '主街商业化，洒金桥更本地' },
    { id: 'shanxihistory', name: '陕西历史博物馆', lat: 34.223, lng: 108.953, category: '博物馆', tags: ['历史', '需预约'], ticket: 0, suggest_min: 150, satisfaction: 0.92, note: '免费但要抢预约，珍宝馆另购票' },
    { id: 'huaqing', name: '华清宫', lat: 34.362, lng: 109.213, category: '历史', tags: ['遗址', '演出'], ticket: 120, suggest_min: 150, satisfaction: 0.85, note: '可与兵马俑同一天（同在临潼）' },
    { id: 'belltower', name: '钟楼·鼓楼', lat: 34.261, lng: 108.943, category: '地标', tags: ['地标'], ticket: 30, suggest_min: 60, satisfaction: 0.82, note: '市中心，顺路打卡即可' },
    { id: 'beilin', name: '西安碑林博物馆', lat: 34.252, lng: 108.947, category: '博物馆', tags: ['书法', '历史'], ticket: 65, suggest_min: 90, satisfaction: 0.84, note: '书法爱好者必去' },
  ],
  hangzhou: [
    { id: 'westlake', name: '西湖（湖滨·断桥）', lat: 30.260, lng: 120.156, category: '湖泊', tags: ['世界遗产', '必去'], ticket: 0, suggest_min: 150, satisfaction: 0.96, note: '断桥—白堤—孤山一线最经典' },
    { id: 'leifeng', name: '雷峰塔', lat: 30.231, lng: 120.148, category: '历史', tags: ['地标', '日落'], ticket: 40, suggest_min: 60, satisfaction: 0.83, note: '塔顶看西湖日落最佳' },
    { id: 'lingyin', name: '灵隐寺·飞来峰', lat: 30.247, lng: 120.098, category: '寺庙', tags: ['寺庙', '石窟'], ticket: 75, suggest_min: 120, satisfaction: 0.90, note: '飞来峰门票含灵隐寺，早上人少' },
    { id: 'hefang', name: '清河坊·河坊街', lat: 30.244, lng: 120.166, category: '街区', tags: ['美食', '老街'], ticket: 0, suggest_min: 90, satisfaction: 0.80, note: '离西湖近，顺路吃晚饭' },
    { id: 'songcheng', name: '宋城', lat: 30.196, lng: 120.115, category: '乐园', tags: ['演出', '亲子'], ticket: 320, suggest_min: 210, satisfaction: 0.85, note: '《宋城千古情》演出是核心' },
    { id: 'xixi', name: '西溪国家湿地公园', lat: 30.273, lng: 120.063, category: '湿地', tags: ['自然', '摇橹船'], ticket: 80, suggest_min: 180, satisfaction: 0.84, note: '坐摇橹船进深处才好玩' },
    { id: 'canal', name: '京杭大运河·拱宸桥', lat: 30.325, lng: 120.142, category: '历史', tags: ['世界遗产', '夜景'], ticket: 0, suggest_min: 90, satisfaction: 0.78, note: '傍晚桥边喝茶，人少清静' },
    { id: 'longjing', name: '龙井村·九溪烟树', lat: 30.215, lng: 120.105, category: '自然', tags: ['茶园', '徒步'], ticket: 0, suggest_min: 120, satisfaction: 0.79, note: '春天采茶季最美' },
  ],
  guangzhou: [
    { id: 'cantontower', name: '广州塔', lat: 23.107, lng: 113.323, category: '地标', tags: ['夜景', '观景'], ticket: 150, suggest_min: 90, satisfaction: 0.92, note: '傍晚上去一次看日景+夜景' },
    { id: 'chenpi', name: '陈家祠', lat: 23.126, lng: 113.247, category: '历史', tags: ['建筑', '岭南'], ticket: 10, suggest_min: 60, satisfaction: 0.87, note: '岭南建筑木雕砖雕巅峰' },
    { id: 'shamian', name: '沙面岛', lat: 23.108, lng: 113.237, category: '街区', tags: ['欧式建筑', '拍照'], ticket: 0, suggest_min: 90, satisfaction: 0.84, note: '老洋房适合慢逛拍照' },
    { id: 'yuexiu', name: '越秀公园·五羊雕像', lat: 23.147, lng: 113.267, category: '公园', tags: ['地标', '公园'], ticket: 0, suggest_min: 90, satisfaction: 0.82, note: '广州城徽五羊雕像在这' },
    { id: 'beijingrd', name: '北京路步行街', lat: 23.131, lng: 113.269, category: '商圈', tags: ['购物', '美食'], ticket: 0, suggest_min: 90, satisfaction: 0.80, note: '脚下有千年古道遗址' },
    { id: 'shangxiajiu', name: '上下九步行街', lat: 23.116, lng: 113.245, category: '商圈', tags: ['美食', '骑楼'], ticket: 0, suggest_min: 90, satisfaction: 0.79, note: '骑楼老街，小吃集中' },
    { id: 'baiyun', name: '白云山', lat: 23.183, lng: 113.299, category: '自然', tags: ['户外', '登山'], ticket: 5, suggest_min: 180, satisfaction: 0.83, note: '市区绿肺，早晨空气最好' },
    { id: 'changlong', name: '长隆野生动物世界', lat: 22.998, lng: 113.330, category: '乐园', tags: ['亲子', '一整天'], ticket: 300, suggest_min: 300, satisfaction: 0.93, note: '在番禺，单独占一天' },
    { id: 'zhujiangnew', name: '花城广场·海心桥', lat: 23.119, lng: 113.321, category: '地标', tags: ['夜景', 'CBD'], ticket: 0, suggest_min: 60, satisfaction: 0.82, note: '与广州塔隔江对望，晚上去' },
  ],
};

const POIMAP = {};
Object.values(POIS).forEach(list => list.forEach(p => { POIMAP[p.id] = p; }));
const CITYMAP = {};
CITIES.forEach(c => { CITYMAP[c.id] = c; });

/* ================= 小工具 ================= */

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

function hav(a, b) { // 两点球面距离，km
  const r = Math.PI / 180, R = 6371;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const roadKm = (a, b) => hav(a, b) * 1.35; // 直线 → 路网系数

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
  from: CITYMAP.shanghai,
  to: CITYMAP.chengdu,
  date: '',
  transport: null,      // 选中的城际方式 {id,name,icon,min,cost}
  intercity: null,      // {d, list}
  selected: [],         // 目的地景点 id
  orders: {},           // {recommended:[ids], popular:[ids], custom:[ids]}
  scheme: 'recommended',
  modes: [],            // 每段通勤方式 id
  closed: true,
  withTicket: true,
  step: 1,
  maxStep: 1,
};

const hubOf = c => ({ name: c.hub, lat: c.hubLat ?? c.lat, lng: c.hubLng ?? c.lng, isHub: true });

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

function renderSpots() {
  const list = POIS[state.to.id];
  const hub = hubOf(state.to);
  $('#destName').textContent = state.to.name;
  $('#spotGrid').innerHTML = list.map(p => {
    const on = state.selected.includes(p.id);
    const km = hav(hub, p);
    return `<button class="spot${on ? ' on' : ''}" data-id="${p.id}">
      <span class="tick">${on ? '✓' : ''}</span>
      <span class="nm">${p.name}</span>
      <span class="meta"><span>${p.category}</span><span>${p.ticket ? '¥' + p.ticket : '免费'}</span><span>约 ${fmtDur(p.suggest_min)}</span><span>${fmtKm(km)}</span></span>
      <span class="bar"><i style="width:${Math.round(p.satisfaction * 100)}%"></i></span>
    </button>`;
  }).join('');
  updateSelInfo();
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
  [a, b].forEach((c, i) => {
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
  POIS[state.to.id].forEach(p => {
    const m = L.circleMarker([p.lat, p.lng], {
      radius: 7, color: '#fff', weight: 2,
      fillColor: state.selected.includes(p.id) ? '#1f6b4f' : '#a8a093', fillOpacity: 0.95,
    }).addTo(gSpots);
    m.bindPopup(`<b>${p.name}</b><br>${p.category} · ${p.ticket ? '门票 ¥' + p.ticket : '免费'} · 建议玩 ${fmtDur(p.suggest_min)}<br>${p.note || ''}`);
    m.on('click', () => { if (state.step === 3) toggleSpot(p.id); });
    spotMarkers[p.id] = m;
  });
  if (fit) fitPts(POIS[state.to.id]);
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
    '选择出发地与目的地，点「查询交通方式」',
    '两地位置与交通对比；地图上可先看目的地景点分布',
    '地图即景点分布：点圆点或左侧卡片勾选景点',
    '路线已画出：颜色对应通勤方式，点线段可跳转导航',
    '点任意线段或图钉，可在高德地图中打开导航',
  ][n - 1];
  if (n === 2) showIntercity();
  if (n === 3) showSpots(false);
  if (n >= 4) drawRoute(n === 4 || n === 5 ? true : false);
}

/* ================= 方案生成与切换 ================= */

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

function bind() {
  // 步骤 1
  const fill = (sel, def) => {
    sel.innerHTML = CITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    sel.value = def;
  };
  fill($('#fromSel'), state.from.id);
  fill($('#toSel'), state.to.id);
  $('#dateInp').value = new Date().toISOString().slice(0, 10);

  $('#btnSwap').addEventListener('click', () => {
    const f = $('#fromSel').value;
    $('#fromSel').value = $('#toSel').value;
    $('#toSel').value = f;
  });

  $('#btnQuery').addEventListener('click', () => {
    const f = CITYMAP[$('#fromSel').value], t = CITYMAP[$('#toSel').value];
    if (!f || !t) return toast('请选择出发地和目的地');
    if (f.id === t.id) return toast('出发地和目的地不能是同一座城市');
    state.from = f; state.to = t;
    state.date = $('#dateInp').value;
    state.transport = null;
    state.selected = [];
    state.intercity = intercityOptions(f, t);
    renderTransport();
    $('#btnTo3').disabled = true;
    waitMap(() => { showIntercity(); showSpots(false); });
    gotoStep(2);
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
  $('#spotGrid').addEventListener('click', e => {
    const card = e.target.closest('.spot');
    if (card) toggleSpot(card.dataset.id);
  });
  $('#btnClassic').addEventListener('click', () => {
    const top4 = POIS[state.to.id].slice().sort((a, b) => b.satisfaction - a.satisfaction).slice(0, 4);
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
      const idx = +navspot.dataset.i; // 在 order 中的下标；对应 seq 中 i = idx+1
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
