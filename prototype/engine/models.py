"""核心数据模型。

只有一条设计原则：**时间一律用"当天第几分钟"的整数**（09:00 -> 540）。
编排、约束校验、增量重算全部在这个整数域里做，避免 datetime / 时区 / 跨天
把逻辑搅乱；需要展示时再用 fmt() 转回 "HH:MM"。
"""

from dataclasses import dataclass, field
from typing import Optional


def hm(text: str) -> int:
    """'08:30' -> 510"""
    h, m = text.split(":")
    return int(h) * 60 + int(m)


def fmt(minutes: float) -> str:
    """510 -> '08:30'（超过 24 点按 24 小时回绕显示，仅为容错）"""
    total = int(round(minutes))
    total %= 24 * 60
    return f"{total // 60:02d}:{total % 60:02d}"


@dataclass(frozen=True)
class Access:
    """POI 的"最后一公里"接入方式：地铁站 + 出口，可选一段公交。"""
    station: str
    exit: str
    walk_m: int
    bus: Optional[dict] = None

    @classmethod
    def from_dict(cls, d):
        if not d:
            return None
        return cls(station=d["station"], exit=d["exit"], walk_m=d["walk_m"], bus=d.get("bus"))


@dataclass(frozen=True)
class POI:
    id: str
    name: str
    lat: float
    lng: float
    category: str
    tags: tuple
    open_min: int
    close_min: int
    closed_weekdays: tuple
    ticket: float
    suggest_min: int
    min_min: int
    max_min: int
    satisfaction: float
    indoor: bool
    access: Optional[Access]
    note: str = ""
    rain_ok: bool = False

    def as_place(self) -> "Place":
        return Place(id=self.id, name=self.name, lat=self.lat, lng=self.lng, access=self.access)


@dataclass(frozen=True)
class Place:
    """路由的起终点。POI 和酒店都转成 Place 再进路由器。"""
    id: str
    name: str
    lat: float
    lng: float
    access: Optional[Access] = None


@dataclass
class Leg:
    """一段"从上一站到这里"的完整出行链。"""
    mode: str                 # walk / transit / taxi
    duration_min: float
    walk_m: int
    fare: float
    steps: list = field(default_factory=list)
    source: str = "mock"
    wait_min: float = 0.0     # 其中用于等车的部分（已包含在 duration 里）


@dataclass
class Item:
    kind: str                 # visit / lunch
    poi: Optional[POI]
    arrive: int
    leave: int
    leg: Optional[Leg] = None  # 到达本项所用的交通（lunch 为 None）
    reason: str = ""
    wait_min: float = 0.0      # 到得太早产生的等待

    @property
    def dwell(self) -> int:
        return self.leave - self.arrive


@dataclass
class DayPlan:
    day: int
    items: list = field(default_factory=list)
    feasible: bool = True
    violations: list = field(default_factory=list)
    skipped: list = field(default_factory=list)
    travel_min: float = 0.0
    walk_m: int = 0
    fare: float = 0.0
    ticket: float = 0.0
    wait_min: float = 0.0
    sat: float = 0.0
    end_min: int = 0

    @property
    def visits(self):
        return [it for it in self.items if it.kind == "visit"]

    def poi_ids(self):
        return [it.poi.id for it in self.visits]


@dataclass
class Trip:
    city: str
    ids: list
    days: int
    cfg: dict
    dayplans: list = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    relaxations: list = field(default_factory=list)

    @property
    def feasible(self) -> bool:
        return all(d.feasible for d in self.dayplans)


def load_pois(path) -> dict:
    import json
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    pois = {}
    for d in raw["pois"]:
        p = POI(
            id=d["id"], name=d["name"], lat=d["lat"], lng=d["lng"],
            category=d["category"], tags=tuple(d.get("tags", [])),
            open_min=hm(d["open"]), close_min=hm(d["close"]),
            closed_weekdays=tuple(d.get("closed_weekdays", [])),
            ticket=float(d["ticket"]), suggest_min=d["suggest_min"],
            min_min=d["min_min"], max_min=d["max_min"],
            satisfaction=float(d["satisfaction"]), indoor=bool(d["indoor"]),
            access=Access.from_dict(d.get("access")), note=d.get("note", ""),
            rain_ok=bool(d.get("rain_ok", False)),
        )
        pois[p.id] = p
    return pois
