"""编排层：把"用户勾选的景点集合"变成"每天可执行的时刻表"。

做了什么：
  1. 分天（地理聚类，避免一天横穿全城）
  2. 每天求访问顺序（贪心插入 + 2-opt，带时间窗可行性检查）
  3. 时间推进模拟（含等车、压缩停留、午餐窗、闭馆、每日结束时间）
  4. 无解时按优先级松弛，并**记录牺牲了什么**
  5. 增量：加/减一个景点，返回时间、步行、费用、结束时刻的 diff

没做什么（故意的）：
  - 不做单段路径计算（那是地图 API 的事，见 providers/transit.py）
  - 不生成一句自然语言（那是 LLM 的事，见 explain.py 的模板版）
"""

import time as _time
from dataclasses import dataclass, field

from .models import DayPlan, Item, Place, Trip, fmt, hm


@dataclass
class Config:
    day_start: int = hm("09:00")
    day_end: int = hm("21:30")
    budget: float = 2000.0
    walk_limit_m: int = 6000
    speed: float = 1.2
    lunch_start: int = hm("11:30")
    lunch_end: int = hm("14:30")
    lunch_min: int = 60
    entry_buffer: int = 30
    start_weekday: int = 6          # 1=周一；6=周六
    w_travel: float = 1.0
    w_wait: float = 0.5
    w_sat: float = 25.0

    def weekday_of(self, day_index: int) -> int:
        return (self.start_weekday - 2 + day_index) % 7 + 1

    @classmethod
    def profile(cls, party="成人", budget=2000, walk_limit=6000, start_weekday=6,
                day_start="09:00", day_end="21:30"):
        speeds = {"成人": 1.2, "老人": 1.0, "带娃": 0.9}
        return cls(
            budget=budget, walk_limit_m=walk_limit,
            speed=speeds.get(party, 1.2), start_weekday=start_weekday,
            day_start=hm(day_start), day_end=hm(day_end),
        )


@dataclass
class Sim:
    ok: bool
    reason: str = ""
    items: list = field(default_factory=list)
    travel: float = 0.0
    wait: float = 0.0
    walk: int = 0
    fare: float = 0.0
    ticket: float = 0.0
    sat: float = 0.0
    end: float = 0.0
    idle: float = 0.0

    @property
    def value(self) -> float:
        # 目标函数：少坐车 + 少干等 + 多去高分点。
        # idle 是"到了还没开门"的空耗，必须罚，否则会排出 09:12 到了却 10:00 才进门的行程。
        return self.travel + self.idle - 25.0 * self.sat


class Planner:
    def __init__(self, pois: dict, transit, hotel: Place):
        self.pois = pois
        self.transit = transit
        self.hotel = hotel
        self._leg_cache = {}

    # ---------- 基础 ----------

    def _place(self, x) -> Place:
        return x if isinstance(x, Place) else x.as_place()

    def leg(self, prev, poi):
        key = (prev.id, poi.id, self.transit.speed)
        if key not in self._leg_cache:
            self._leg_cache[key] = self.transit.route(self._place(prev), self._place(poi))
        return self._leg_cache[key]

    # ---------- 单日模拟 ----------

    def _lunch(self, t: float, prev, cfg: Config) -> Item:
        where = prev.name if prev is not None else "附近"
        arrive = int(round(t))
        return Item("lunch", None, arrive, arrive + cfg.lunch_min, None, f"在{where}附近用餐")

    def _reason(self, poi, leg, start: float) -> str:
        """给用户一句"为什么排在这"的理由。真产品里这里换成 LLM，事实来自 leg。"""
        if leg.mode == "walk" and leg.duration_min <= 10:
            return f"离上一站步行 {leg.duration_min:.0f} 分钟，顺路"
        if 0 <= start - poi.open_min <= 10:
            return "刚开门就到，人最少"
        if poi.close_min - start <= 120:
            return "临近闭馆前进入，避开午后高峰"
        return poi.note

    def _simulate(self, order, day: int, cfg: Config) -> Sim:
        weekday = cfg.weekday_of(day)
        t = float(cfg.day_start)
        prev = self.hotel
        items, travel, wait = [], 0.0, 0.0
        walk, fare, ticket, sat = 0, 0.0, 0.0, 0.0
        idle = 0.0
        lunch_done = False

        for pid in order:
            poi = self.pois[pid]
            if weekday in poi.closed_weekdays:
                return Sim(False, f"{poi.name} 周{weekday}闭馆")

            if not lunch_done and cfg.lunch_start <= t <= cfg.lunch_end:
                items.append(self._lunch(t, prev, cfg))
                t += cfg.lunch_min
                lunch_done = True
                if t > cfg.day_end:
                    return Sim(False, "午餐后已超过当天结束时间")

            leg = self.leg(prev, poi)
            arrive = t + leg.duration_min
            if arrive > poi.close_min - cfg.entry_buffer:
                return Sim(False, f"到{poi.name}已 {fmt(arrive)}，超过最后入场时间")
            start = max(arrive, float(poi.open_min))
            w = start - arrive
            leave = start + poi.suggest_min
            if leave > poi.close_min:
                leave = float(poi.close_min)
                if leave - start < poi.min_min:
                    return Sim(False, f"{poi.name} 剩余时间不够最短停留")

            items.append(Item("visit", poi, int(round(start)), int(round(leave)), leg,
                              self._reason(poi, leg, start), w))
            travel += leg.duration_min
            wait += w + leg.wait_min
            idle += w
            walk += leg.walk_m
            fare += leg.fare
            ticket += poi.ticket
            sat += poi.satisfaction
            t = leave
            prev = poi

            if not lunch_done and cfg.lunch_start <= t <= cfg.lunch_end:
                items.append(self._lunch(t, prev, cfg))
                t += cfg.lunch_min
                lunch_done = True

            if t > cfg.day_end:
                return Sim(False, f"第 {day} 天按此顺序已到 {fmt(t)}，超过 {fmt(cfg.day_end)}")
            if walk > cfg.walk_limit_m:
                return Sim(False, f"步行 {walk} 米超过体力上限 {cfg.walk_limit_m} 米")
            if ticket + fare > cfg.budget:
                return Sim(False, "超出预算")

        if not items:
            return Sim(False, "空行程")
        return Sim(ok=True, items=items, travel=travel, wait=wait, walk=walk,
                   fare=fare, ticket=ticket, sat=sat, end=t, idle=idle)

    # ---------- 单日求序 ----------

    def _two_opt(self, order, day, cfg):
        if len(order) < 3:
            return order
        best_value = self._simulate(order, day, cfg).value
        improved, rounds = True, 0
        while improved and rounds < 12:
            improved, rounds = False, rounds + 1
            for i in range(len(order) - 1):
                for j in range(i + 2, len(order) + 1):
                    cand = order[:i] + list(reversed(order[i:j])) + order[j:]
                    s = self._simulate(cand, day, cfg)
                    if s.ok and s.value < best_value - 1e-6:
                        order, best_value, improved = cand, s.value, True
                        break
                if improved:
                    break
        return order

    def _best_order(self, pool, day, cfg):
        if not pool:
            return Sim(True, "", []), set()
        starts = sorted(pool, key=lambda p: -self.pois[p].satisfaction)[:6]
        best, best_skipped = None, set(pool)
        for start in starts:
            order = [start]
            rest = set(pool) - {start}
            while rest:
                pick = None
                for pid in rest:
                    for pos in range(len(order) + 1):
                        trial = order[:pos] + [pid] + order[pos:]
                        s = self._simulate(trial, day, cfg)
                        if not s.ok:
                            continue
                        if pick is None or s.value < pick[0]:
                            pick = (s.value, pos, pid, trial)
                if pick is None:
                    break
                order = pick[3]
                rest.discard(pick[2])
            order = self._two_opt(order, day, cfg)
            s = self._simulate(order, day, cfg)
            if s.ok and (best is None or s.value < best.value):
                best, best_skipped = s, set(pool) - set(order)
        return best, best_skipped

    def _solve_day(self, pool, day, cfg):
        pool = list(dict.fromkeys(pool))
        relaxed = []
        while True:
            if not pool:
                return DayPlan(day, []), relaxed
            sim, skipped = self._best_order(pool, day, cfg)
            if sim and sim.ok:
                for p in skipped:
                    relaxed.append(
                        f"第{day}天：{self.pois[p].name} 排不进去（时间/闭馆），已跳过"
                        f"——要么加半天，要么换掉同区域里分更低的点"
                    )
                dp = DayPlan(
                    day=day, items=sim.items, feasible=True,
                    skipped=sorted(skipped), travel_min=sim.travel, walk_m=sim.walk,
                    fare=sim.fare, ticket=sim.ticket, wait_min=sim.wait,
                    sat=sim.sat, end_min=int(round(sim.end)),
                )
                return dp, relaxed
            drop = min(pool, key=lambda p: self.pois[p].satisfaction)
            pool.remove(drop)
            relaxed.append(f"第{day}天：{self.pois[drop].name} 与当天时间冲突，已舍弃")

    # ---------- 分天 ----------

    def _split(self, ids, days):
        ids = list(dict.fromkeys(ids))
        if days <= 1:
            return [ids]
        if len(ids) <= days:
            groups = [[] for _ in range(days)]
            for k, pid in enumerate(ids):
                groups[k].append(pid)
            return groups
        pts = [(self.pois[i].lng, self.pois[i].lat) for i in ids]
        order = sorted(range(len(ids)), key=lambda k: pts[k][0] + pts[k][1])
        size = len(ids) / days
        groups = []
        for d in range(days):
            lo = int(d * size)
            hi = int((d + 1) * size) if d < days - 1 else len(ids)
            groups.append(order[lo:hi])
        cent = [(sum(pts[k][0] for k in g) / len(g), sum(pts[k][1] for k in g) / len(g)) for g in groups]
        for _ in range(8):
            newg = [[] for _ in range(days)]
            for k in order:
                d = min(range(days), key=lambda x: (pts[k][0] - cent[x][0]) ** 2 + (pts[k][1] - cent[x][1]) ** 2)
                newg[d].append(k)
            if any(len(g) == 0 for g in newg):
                break
            groups = newg
            cent = [(sum(pts[k][0] for k in g) / len(g), sum(pts[k][1] for k in g) / len(g)) for g in groups]
        groups = self._balance(groups, days, pts)
        return [[ids[k] for k in g] for g in groups]

    def _balance(self, groups, days, pts):
        """聚类容易一头重一头轻，把大的一天里最靠近小的一天的点挪过去。"""
        for _ in range(8):
            sizes = [len(g) for g in groups]
            if max(sizes) - min(sizes) <= 1:
                break
            big = max(range(days), key=lambda i: sizes[i])
            small = min(range(days), key=lambda i: sizes[i])
            if sizes[big] - sizes[small] <= 1:
                break
            cx = sum(pts[k][0] for k in groups[small]) / len(groups[small])
            cy = sum(pts[k][1] for k in groups[small]) / len(groups[small])
            pid = min(groups[big], key=lambda k: (pts[k][0] - cx) ** 2 + (pts[k][1] - cy) ** 2)
            groups[big].remove(pid)
            groups[small].append(pid)
        return groups

    # ---------- 对外 ----------

    def plan(self, ids, days: int, cfg: Config = None) -> Trip:
        cfg = cfg or Config()
        self.transit.set_speed(cfg.speed)
        ids = [i for i in ids if i in self.pois]
        groups = self._split(ids, days)
        dayplans, relaxed = [], []
        for d, group in enumerate(groups, 1):
            dp, rel = self._solve_day(group, d, cfg)
            dayplans.append(dp)
            relaxed.extend(rel)
        trip = Trip(city="成都", ids=list(ids), days=days, cfg=cfg, dayplans=dayplans)
        self.recompute(trip)
        trip.relaxations = relaxed
        return trip

    def recompute(self, trip: Trip):
        m = {"travel": 0.0, "walk": 0, "fare": 0.0, "ticket": 0.0, "wait": 0.0, "sat": 0.0, "end": 0}
        for dp in trip.dayplans:
            m["travel"] += dp.travel_min
            m["walk"] += dp.walk_m
            m["fare"] += dp.fare
            m["ticket"] += dp.ticket
            m["wait"] += dp.wait_min
            m["sat"] += dp.sat
            m["end"] = max(m["end"], dp.end_min)
        m["poi_count"] = sum(len(dp.visits) for dp in trip.dayplans)
        m["days_used"] = sum(1 for dp in trip.dayplans if dp.items)
        trip.metrics = {k: (round(v, 1) if isinstance(v, float) else v) for k, v in m.items()}
        return trip

    def assigned(self, trip: Trip):
        return {it.poi.id for dp in trip.dayplans for it in dp.visits}

    def diff(self, a: Trip, b: Trip):
        keys = ["travel", "walk", "fare", "ticket", "poi_count", "end"]
        return {k: round(b.metrics.get(k, 0) - a.metrics.get(k, 0), 1) for k in keys}

    # ---------- 增量：加/减一个景点 ----------

    def _rebuild(self, sim, day):
        return DayPlan(
            day=day, items=sim.items, feasible=True,
            travel_min=sim.travel, walk_m=sim.walk, fare=sim.fare,
            ticket=sim.ticket, wait_min=sim.wait, sat=sim.sat,
            end_min=int(round(sim.end)),
        )

    def _try_insert(self, dp, pid, day, cfg):
        """在已有某天里试插一个点，返回最优可行解（不动其它天）。"""
        order = dp.poi_ids()
        best = None
        for pos in range(len(order) + 1):
            trial = order[:pos] + [pid] + order[pos:]
            s = self._simulate(trial, day, cfg)
            if not s.ok:
                continue
            delta = (s.travel + s.idle) - dp.travel_min
            if best is None or delta < best[0]:
                best = (delta, s)
        return best

    def add_poi(self, trip: Trip, pid: str):
        """勾选一个点：保留已排好的行程，只做插入/替换，返回代价 diff。"""
        if pid in trip.ids:
            return None
        t0 = _time.perf_counter()
        old_assigned = self.assigned(trip)
        best = None
        for dp in trip.dayplans:
            cand = self._try_insert(dp, pid, dp.day, trip.cfg)
            if cand and (best is None or cand[0] < best[0]):
                best = (cand[0], dp.day, cand[1], None)

        if best is None:
            # 插不进去：只能替换当天一个满意度更低的点
            for dp in trip.dayplans:
                for victim in dp.poi_ids():
                    if self.pois[victim].satisfaction >= self.pois[pid].satisfaction:
                        continue
                    order = [p for p in dp.poi_ids() if p != victim]
                    for pos in range(len(order) + 1):
                        trial = order[:pos] + [pid] + order[pos:]
                        s = self._simulate(trial, dp.day, trip.cfg)
                        if not s.ok:
                            continue
                        delta = (s.travel + s.idle) - dp.travel_min
                        if best is None or delta < best[0]:
                            best = (delta, dp.day, s, victim)
        if best is None:
            return {"action": "add", "poi": pid, "name": self.pois[pid].name,
                    "trip": trip, "seconds": _time.perf_counter() - t0,
                    "dropped": [], "impossible": True,
                    "delta": {k: 0 for k in ["travel", "walk", "fare", "ticket", "poi_count", "end"]}}

        _, day, sim, victim = best
        dayplans = list(trip.dayplans)
        dayplans[day - 1] = self._rebuild(sim, day)
        new = Trip(city=trip.city, ids=trip.ids + [pid], days=trip.days,
                   cfg=trip.cfg, dayplans=dayplans)
        self.recompute(new)
        new.relaxations = list(trip.relaxations)
        if victim:
            new.relaxations.append(
                f"加入{self.pois[pid].name} 需要放弃{self.pois[victim].name}"
                f"（当天放不下两个）"
            )
        return {
            "action": "add", "poi": pid, "name": self.pois[pid].name,
            "trip": new, "seconds": _time.perf_counter() - t0,
            "dropped": sorted(old_assigned - self.assigned(new)),
            "delta": self.diff(trip, new),
        }

    def remove_poi(self, trip: Trip, pid: str):
        if pid not in trip.ids:
            return None
        t0 = _time.perf_counter()
        dayplans = list(trip.dayplans)
        for dp in trip.dayplans:
            if pid in dp.poi_ids():
                order = [p for p in dp.poi_ids() if p != pid]
                sim, _ = self._best_order(order, dp.day, trip.cfg) if order else (None, set())
                if sim and sim.ok:
                    dayplans[dp.day - 1] = self._rebuild(sim, dp.day)
                else:
                    dayplans[dp.day - 1] = DayPlan(day=dp.day, items=[])
                break
        new = Trip(city=trip.city, ids=[i for i in trip.ids if i != pid], days=trip.days,
                   cfg=trip.cfg, dayplans=dayplans)
        self.recompute(new)
        new.relaxations = list(trip.relaxations)
        return {
            "action": "remove", "poi": pid, "name": self.pois[pid].name,
            "trip": new, "seconds": _time.perf_counter() - t0, "dropped": [],
            "delta": self.diff(trip, new),
        }

    # ---------- 扰动：局部重排 ----------

    def replan_day(self, trip: Trip, day: int, mode: str = "rain"):
        """只重排某一天，其余天不动——这就是"局部修复"的最小实现。"""
        dp = trip.dayplans[day - 1]
        carried = dp.poi_ids()
        if mode == "rain":
            pool = [p for p in carried if self.pois[p].rain_ok]
            removed = [p for p in carried if p not in pool]
            spares = [p for p in self.pois
                      if self.pois[p].rain_ok and p not in trip.ids]
            pool += spares[:2]
            if removed:
                trip.relaxations.append(
                    f"第{day}天下雨：移出户外点 " + "、".join(self.pois[p].name for p in removed)
                )
        else:
            pool = list(carried)
        new_dp, rel = self._solve_day(pool, day, trip.cfg)
        trip.dayplans[day - 1] = new_dp
        trip.relaxations.extend(rel)
        self.recompute(trip)
        return trip
