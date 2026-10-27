/* 行程编排原型 · 前端（无框架，一个文件）
   交互主线：勾景点 -> 立刻看到代价 -> 行程随之更新 -> 某天下雨只重排那天 */

const STARTER = ["kuanzhai", "renmin", "wuhou", "jinli", "cdmuseum", "chunxi", "dufu", "jinsha"];
const WD = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

const state = {
  meta: null,
  ids: STARTER.slice(),
  days: 3,
  party: "老人",
  pace: "标准",
  budget: 1500,
  start_weekday: 5,
  trip: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function hm(mins) {
  const m = Math.round(mins || 0);
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

function nameOf(pid) {
  const p = state.meta.pois.find((x) => x.id === pid);
  return p ? p.name : pid;
}

async function api(path, body) {
  const opt = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const r = await fetch(path, opt);
  let data = {};
  try {
    data = await r.json();
  } catch (e) {
    /* 非 JSON 响应 */
  }
  if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
  return data;
}

function reqBody(extra) {
  return Object.assign(
    {
      ids: state.ids,
      days: state.days,
      party: state.party,
      pace: state.pace,
      budget: Number(state.budget),
      start_weekday: Number(state.start_weekday),
    },
    extra || {}
  );
}

/* ---------------- 初始化 ---------------- */

(async function init() {
  try {
    state.meta = await api("/api/meta");
  } catch (e) {
    document.body.innerHTML =
      '<div class="empty">后端没起来（' + esc(e.message) + "）：先在 prototype 目录运行 <b>python serve.py</b></div>";
    return;
  }
  buildWeekday();
  bindControls();
  buildPool();
  $("summary").innerHTML = '<div class="empty" style="padding:18px">正在生成…</div>';
  await planNow();
})();

function buildWeekday() {
  const sel = $("weekday");
  sel.innerHTML = WD.map((w, i) => `<option value="${i + 1}" ${i + 1 === state.start_weekday ? "selected" : ""}>${w}</option>`).join("");
  sel.addEventListener("change", () => {
    state.start_weekday = Number(sel.value);
    planNow();
  });
}

function bindSeg(id, key, cast) {
  const box = $(id);
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    state[key] = cast ? cast(b.dataset.v) : b.dataset.v;
    planNow();
  });
}

function bindControls() {
  bindSeg("seg-days", "days", Number);
  bindSeg("seg-party", "party");
  bindSeg("seg-pace", "pace");

  const budget = $("budget");
  let timer = null;
  budget.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.budget = budget.value;
      planNow();
    }, 450);
  });
  budget.addEventListener("change", () => {
    state.budget = budget.value;
    planNow();
  });
}

/* ---------------- 景点池 ---------------- */

function buildPool() {
  const pool = $("pool");
  pool.innerHTML = state.meta.pois
    .map((p) => {
      const on = state.ids.includes(p.id);
      return `<button class="poi ${on ? "on" : ""}" data-id="${esc(p.id)}">
        <span class="tick">✓</span>
        <span class="pname">${esc(p.name)}</span>
        <span class="pmeta">${esc(p.category)} · ${p.suggest_min}′ · ${p.ticket ? "¥" + p.ticket : "免费"}</span>
        <span class="ptags">${(p.tags || []).slice(0, 2).map((t) => `<i>${esc(t)}</i>`).join("")}</span>
      </button>`;
    })
    .join("");
  $("sel-count").textContent = "已选 " + state.ids.length + " 个";
  pool.querySelectorAll(".poi").forEach((b) => b.addEventListener("click", () => toggle(b.dataset.id)));
}

/* ---------------- 生成 / 勾选 / 重排 ---------------- */

function setBusy(b) {
  state.busy = b;
  document.body.classList.toggle("busy", b);
}

async function planNow() {
  if (state.busy) return;
  if (!state.ids.length) {
    state.trip = null;
    renderSummary(null, []);
    renderItinerary(null, []);
    return;
  }
  setBusy(true);
  try {
    const res = await api("/api/plan", reqBody());
    state.trip = res.trip;
    render(res);
  } catch (e) {
    toast("生成失败：" + e.message, true);
  } finally {
    setBusy(false);
  }
}

async function toggle(pid) {
  if (state.busy) return;
  const before = state.ids.slice();
  const adding = !before.includes(pid);
  state.ids = adding ? before.concat(pid) : before.filter((x) => x !== pid);
  buildPool();
  setBusy(true);
  try {
    const res = await api("/api/toggle", Object.assign(reqBody(), { ids: before, pid }));
    if (res.impossible) {
      state.ids = before;
      buildPool();
      toast((res.name || "这个点") + " 排不进当前天数：加一天，或换掉一个点", true);
    } else {
      state.trip = res.trip;
      render(res);
      const d = res.delta || {};
      const sign = (v) => ((v > 0 ? "+" : "") + v);
      if (res.dropped && res.dropped.length) {
        toast("＋" + res.name + "：要放弃 " + res.dropped.map((x) => x.name).join("、"));
      } else {
        toast(
          (adding ? "＋" : "−") +
            res.name +
            " · 交通 " + sign(Math.round(d.travel || 0)) + " 分钟" +
            " · 步行 " + sign(Math.round(d.walk || 0)) + " 米" +
            " · 车费 " + sign(Math.round(d.fare || 0)) + " 元",
          false,
          res.seconds
        );
      }
    }
  } catch (e) {
    state.ids = before;
    buildPool();
    toast("操作失败：" + e.message, true);
  } finally {
    setBusy(false);
  }
}

async function replanDay(day) {
  if (state.busy) return;
  setBusy(true);
  try {
    const res = await api("/api/replan", reqBody({ day, mode: "rain" }));
    state.trip = res.trip;
    render(res);
    toast("第 " + day + " 天已按雨天重排：户外点换成室内点");
  } catch (e) {
    toast("重排失败：" + e.message, true);
  } finally {
    setBusy(false);
  }
}

/* ---------------- 渲染 ---------------- */

function render(res) {
  renderSummary(res.trip, res.violations);
  renderItinerary(res.trip, res.violations);
}

function renderSummary(trip, violations) {
  if (!trip) {
    $("summary").innerHTML = '<div class="empty" style="padding:18px">还没选景点</div>';
    return;
  }
  const m = trip.metrics;
  const bad = (violations || []).length;
  $("summary").innerHTML = `
    <div class="stats">
      <div class="stat"><b>${m.poi_count}</b><span>景点</span></div>
      <div class="stat"><b>${Math.round(m.travel)}<i>′</i></b><span>交通</span></div>
      <div class="stat"><b>${(m.walk / 1000).toFixed(1)}<i>km</i></b><span>步行</span></div>
      <div class="stat"><b>¥${Math.round((m.ticket || 0) + (m.fare || 0))}</b><span>门票+车费</span></div>
      <div class="stat"><b>${hm(m.end)}</b><span>最晚收工</span></div>
    </div>
    <div class="verify ${bad ? "bad" : ""}">${bad ? "⚠ " + bad + " 处违规" : "✓ 校验通过 · 0 违规"}</div>`;
}

function renderItinerary(trip, violations) {
  const box = $("itinerary");
  const alerts = $("alerts");
  alerts.innerHTML = "";
  if (!trip) {
    box.innerHTML = '<div class="card empty">左侧勾几个景点，行程会自动生成</div>';
    return;
  }
  if (trip.relaxations && trip.relaxations.length) {
    alerts.innerHTML =
      '<div class="alerts">' +
      trip.relaxations.map((r) => "<div>· " + esc(r) + "</div>").join("") +
      "</div>";
  }
  box.innerHTML = trip.dayplans.map(dayHTML).join("");
}

function dayHTML(dp) {
  const rows = dp.items
    .map((it) => {
      if (it.kind === "lunch") {
        return `<li class="row lunch">
          <div class="time"><b>${esc(it.arrive)}</b><span>${esc(it.leave)}</span></div>
          <div class="rail"><span class="dot mini"></span></div>
          <div class="body"><div class="lunch-box">🍜 ${esc(it.text)}</div></div>
        </li>`;
      }
      return `<li class="row">
        <div class="time"><b>${esc(it.arrive)}</b><span>${esc(it.leave)}</span></div>
        <div class="rail"><span class="dot"></span></div>
        <div class="body">
          <div class="poi-line">
            <span class="pname">${esc(it.name)}</span>
            <span class="stay">${it.dwell}′</span>
            ${it.ticket ? `<span class="ticket">¥${it.ticket}</span>` : ""}
          </div>
          <div class="chips">${legChips(it.leg)}</div>
          <div class="reason">${esc(it.reason || "")}</div>
        </div>
      </li>`;
    })
    .join("");
  const empty = dp.items.length ? "" : '<div class="empty-day">这天没安排景点</div>';
  const skip =
    dp.skipped && dp.skipped.length
      ? `<div class="skip">未排入：${esc(dp.skipped.join("、"))}（当天时间不够）</div>`
      : "";
  return `<section class="day">
    <div class="day-head">
      <span class="dnum">D${dp.day}</span>
      <span class="dweek">${esc(dp.weekday)}</span>
      <span class="dtime">${esc(dp.start)} → ${esc(dp.end)}</span>
      <button class="rain" data-day="${dp.day}">这天下雨</button>
    </div>
    ${empty}
    <ol class="timeline">${rows}</ol>
    ${skip}
  </section>`;
}

function legChips(leg) {
  if (!leg) return "";
  return (leg.steps || [])
    .map((s) => {
      if (s.type === "walk") return `<span class="chip walk">${esc(s.desc)}</span>`;
      if (s.type === "wait") return `<span class="chip wait">候车 ${Math.round(s.min)}′</span>`;
      if (s.type === "metro") {
        const n = (String(s.line).match(/\d+/) || [""])[0];
        return `<span class="chip metro l${n}">${esc(s.line)}<em>${esc(s.direction || "")}</em></span>
                <span class="hop">${esc(s.board)} → ${esc(s.alight)} · ${s.stops} 站</span>`;
      }
      if (s.type === "bus")
        return `<span class="chip bus">${esc(s.line)} · ${s.stops} 站</span>
                <span class="hop">${esc(s.board)} → ${esc(s.alight)}</span>`;
      if (s.type === "transfer") return `<span class="chip transfer">换乘 ${esc(s.to)}</span>`;
      if (s.type === "taxi") return `<span class="chip taxi">${esc(s.desc)}</span>`;
      return "";
    })
    .join("");
}

/* ---------------- 提示条 ---------------- */

let toastTimer = null;
function toast(msg, warn, ms) {
  const bar = $("costbar");
  bar.className = "costbar show" + (warn ? " warn" : "");
  bar.innerHTML = `<span>${esc(msg)}</span>` + (ms ? `<small>${ms} ms</small>` : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => bar.classList.remove("show"), 4200);
}

$("itinerary").addEventListener("click", (e) => {
  const b = e.target.closest("button.rain");
  if (b) replanDay(Number(b.dataset.day));
});
