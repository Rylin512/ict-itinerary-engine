"""交通事实层（示意实现）。

职责：给定两个地点，返回一段**可展示到出口级**的出行链（Leg）。
真实实现只要换掉 ChengduTransit 内部的两个函数即可：
  - route()      -> 调地图开放平台"公交路径规划 / 步行路径规划"
  - _metro_route -> 直接用 API 返回的换乘方案，不需要自己跑图

现在这套示意网络的意义：把"多段串联 + 换乘 + 出口 + 等车"的数据形状固定下来，
让编排层先在正确的结构上开发，等 API 接进来只换实现不改接口。
"""

import heapq
import math

from ..models import Access, Leg, Place

R_EARTH = 6371000.0


def haversine(lat1, lng1, lat2, lng2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(a))


class ChengduTransit:
    """成都地铁骨架 + 最后一公里步行/示意公交。"""

    source = "mock:chengdu"

    def __init__(self, metro: dict, speed_mps: float = 1.2):
        self.headway = float(metro.get("headway_min", 4))
        self.transfer_min = float(metro.get("transfer_min", 4))
        self.stop_min = float(metro.get("stop_min", 2.2))
        self.lines = metro["lines"]
        self.stations = metro["stations"]
        self.speed = speed_mps
        self.index = {ln: {s: i for i, s in enumerate(d["stops"])} for ln, d in self.lines.items()}
        self.lines_at = {}
        for ln, d in self.lines.items():
            for s in d["stops"]:
                self.lines_at.setdefault(s, []).append(ln)
        self._cache = {}

    # ---------- 对外接口 ----------

    def route(self, a: Place, b: Place) -> Leg:
        key = (a.id, b.id, a.lat, b.lat)
        if key in self._cache:
            return self._cache[key]
        dist = haversine(a.lat, a.lng, b.lat, b.lng)
        options = []
        if dist <= 900:
            options.append(self._walk_only(a, b, dist))
        elif a.access and b.access:
            options.append(self._transit(a, b, dist))
        else:
            options.append(self._taxi(a, b, dist))
        if not options:
            options.append(self._taxi(a, b, dist))
        leg = min(options, key=lambda l: (l.duration_min, l.fare))
        self._cache[key] = leg
        return leg

    def set_speed(self, speed_mps: float):
        if abs(speed_mps - self.speed) > 1e-6:
            self.speed = speed_mps
            self._cache.clear()

    # ---------- 具体实现 ----------

    def _walk_step(self, desc: str, meters: float) -> dict:
        minutes = meters / self.speed / 60
        return {"type": "walk", "desc": desc, "m": int(meters), "min": minutes}

    def _walk_only(self, a: Place, b: Place, dist: float) -> Leg:
        minutes = dist / self.speed / 60
        return Leg(
            mode="walk",
            duration_min=minutes,
            walk_m=int(dist),
            fare=0.0,
            steps=[{"type": "walk", "desc": f"步行 {int(dist)} 米（约 {minutes:.0f} 分钟）", "m": int(dist), "min": minutes}],
            source=self.source,
        )

    def _taxi(self, a: Place, b: Place, dist: float) -> Leg:
        minutes = dist / (28 * 1000 / 60) + 6
        fare = 10 + 2.2 * dist / 1000
        return Leg(
            mode="taxi", duration_min=minutes, walk_m=0, fare=round(fare, 1),
            steps=[{"type": "taxi", "desc": f"打车约 {dist/1000:.1f} 公里（约 {minutes:.0f} 分钟，示意）", "min": minutes}],
            source=self.source,
        )

    def _access_out(self, a: Place):
        """POI -> 车站（或站 -> POI 的反向，direction='out'）"""
        acc: Access = a.access
        steps, walk, fare, total = [], 0, 0.0, 0.0
        if acc.bus:
            bus = acc.bus
            s = self._walk_step(f"步行 {acc.walk_m} 米到{bus['line']}公交站", acc.walk_m)
            steps.append(s); walk += acc.walk_m; total += s["min"]
            wait = float(bus.get("wait_min", 5))
            steps.append({"type": "wait", "min": wait, "desc": f"候车约 {wait:.0f} 分钟"})
            total += wait
            ride = float(bus["ride_min"])
            steps.append({
                "type": "bus", "line": bus["line"], "direction": "往景区方向",
                "board": f"{acc.station}公交站", "alight": f"{a.name}站",
                "stops": 3, "min": ride,
            })
            total += ride; fare += float(bus.get("fare", 2))
            s = self._walk_step("下车后步行 120 米进站", 120)
            steps.append(s); walk += 120; total += s["min"]
        else:
            s = self._walk_step(f"步行 {acc.walk_m} 米到{acc.station}站 {acc.exit} 口进站", acc.walk_m)
            steps.append(s); walk += acc.walk_m; total += s["min"]
        return total, walk, fare, steps

    def _access_in(self, b: Place):
        """车站 -> POI：出站 + 步行（或公交）"""
        acc: Access = b.access
        steps, walk, fare, total = [], 0, 0.0, 0.0
        if acc.bus:
            bus = acc.bus
            s = self._walk_step(f"从 {acc.exit} 口出站，步行 120 米到公交站", 120)
            steps.append(s); walk += 120; total += s["min"]
            wait = float(bus.get("wait_min", 5))
            steps.append({"type": "wait", "min": wait, "desc": f"候车约 {wait:.0f} 分钟"})
            total += wait
            ride = float(bus["ride_min"])
            steps.append({
                "type": "bus", "line": bus["line"], "direction": "往景区方向",
                "board": f"{acc.station}公交站", "alight": f"{b.name}站",
                "stops": 3, "min": ride,
            })
            total += ride; fare += float(bus.get("fare", 2))
            s = self._walk_step(f"下车后步行 {acc.walk_m} 米到{b.name}", acc.walk_m)
            steps.append(s); walk += acc.walk_m; total += s["min"]
        else:
            s = self._walk_step(f"从 {acc.exit} 口出站，步行 {acc.walk_m} 米到{b.name}", acc.walk_m)
            steps.append(s); walk += acc.walk_m; total += s["min"]
        return total, walk, fare, steps

    def _transit(self, a: Place, b: Place, dist: float) -> Leg:
        mins, segments = self._metro_route(a.access.station, b.access.station)
        o_t, o_w, o_f, o_steps = self._access_out(a)
        d_t, d_w, d_f, d_steps = self._access_in(b)

        steps = list(o_steps)
        total = o_t
        prev_line = None
        for seg in segments:
            if prev_line is None:
                wait = self.headway / 2
                steps.append({"type": "wait", "min": wait, "desc": f"候车约 {wait:.0f} 分钟"})
                total += wait
            else:
                t = self.transfer_min + self.headway / 2
                steps.append({
                    "type": "transfer", "station": seg["board"], "to": seg["line"],
                    "min": t, "desc": f"在{seg['board']}站内换乘 {seg['line']}（约 {t:.0f} 分钟）",
                })
                total += t
            steps.append({
                "type": "metro", "line": seg["line"], "direction": seg["direction"],
                "board": seg["board"], "alight": seg["alight"], "stops": seg["stops"],
                "min": seg["min"],
            })
            total += seg["min"]
            prev_line = seg["line"]
        steps.extend(d_steps)
        total += d_t
        wait = sum(s["min"] for s in steps if s["type"] == "wait")
        return Leg(
            mode="transit",
            duration_min=total,
            walk_m=int(o_w + d_w),
            fare=round(o_f + d_f + 2 * max(1, len(segments)), 1),
            steps=steps,
            source=self.source,
            wait_min=wait,
        )

    # ---------- 地铁图搜索：状态 = (站, 线路) ----------

    def _metro_route(self, s1: str, s2: str):
        if s1 == s2 or s1 not in self.lines_at or s2 not in self.lines_at:
            return 0.0, []
        dist, prev = {}, {}
        pq = []
        for ln in self.lines_at[s1]:
            st = (s1, ln)
            dist[st] = self.headway / 2
            heapq.heappush(pq, (dist[st], st))
            prev[st] = None
        best_state, best_cost = None, float("inf")
        while pq:
            d, st = heapq.heappop(pq)
            if d > dist.get(st, float("inf")):
                continue
            station, line = st
            if station == s2 and d < best_cost:
                best_state, best_cost = st, d
                continue  # 不再从这个状态扩展，避免绕远
            stops = self.lines[line]["stops"]
            i = self.index[line][station]
            for j in (i - 1, i + 1):
                if 0 <= j < len(stops):
                    ns = stops[j]
                    nd = d + self.stop_min
                    key = (ns, line)
                    if nd < dist.get(key, float("inf")):
                        dist[key] = nd
                        prev[key] = st
                        heapq.heappush(pq, (nd, key))
            for ln2 in self.lines_at[station]:
                if ln2 == line:
                    continue
                nd = d + self.transfer_min + self.headway / 2
                key = (station, ln2)
                if nd < dist.get(key, float("inf")):
                    dist[key] = nd
                    prev[key] = st
                    heapq.heappush(pq, (nd, key))
        if best_state is None:
            return 0.0, []
        # 回溯出「线路连续段」
        path = []
        cur = best_state
        while cur is not None:
            path.append(cur)
            cur = prev[cur]
        path.reverse()
        segments = []
        for station, line in path:
            if segments and segments[-1]["key"] == line:
                segments[-1]["alight"] = station
            else:
                segments.append({"key": line, "line": None, "board": station,
                                 "alight": station, "stops": 0, "direction": "", "min": 0.0})
        for seg in segments:
            name = self.lines[seg["key"]]["name"]
            stops = self.lines[seg["key"]]["stops"]
            i1 = self.index[seg["key"]][seg["board"]]
            i2 = self.index[seg["key"]][seg["alight"]]
            seg["line"] = name
            seg["stops"] = abs(i2 - i1)
            seg["direction"] = "往" + (stops[-1] if i2 > i1 else stops[0]) + "方向"
            seg["min"] = seg["stops"] * self.stop_min
        total = 0.0
        for k, seg in enumerate(segments):
            total += seg["min"] + (self.headway / 2 if k == 0 else self.transfer_min + self.headway / 2)
        return total, segments
