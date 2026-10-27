"""行程编排引擎（原型）。

分层：
    models       数据模型（时间统一用「当天第几分钟」的整数）
    providers    交通事实层：单段步行/地铁/公交（当前为成都示意网络）
    planner      编排层：分天、求序、时间推进、松弛、增量重算
    validator    独立校验层：重推时间轴，检查硬约束
    explain      表达层（模板版）：结构化结果 -> 人话
"""

from .models import Access, DayPlan, Item, Leg, POI, Place, Trip, fmt, hm, load_pois
from .planner import Config, Planner
from .providers.transit import ChengduTransit, haversine
from .validator import validate

__all__ = [
    "Access", "POI", "Place", "Leg", "Item", "DayPlan", "Trip",
    "fmt", "hm", "load_pois", "Config", "Planner",
    "ChengduTransit", "haversine", "validate",
]
