"""把 Trip 序列化成前端能直接用的 JSON。

约定：时间给两套——字符串（直接展示）和分钟数（画时间轴用），
省得前端再写一遍解析。
"""

from .models import fmt


def _step(s):
    d = {"type": s["type"], "min": round(float(s["min"]), 1)}
    for k in ("desc", "line", "direction", "board", "alight", "station", "to"):
        if k in s:
            d[k] = s[k]
    if "stops" in s:
        d["stops"] = int(s["stops"])
    if "m" in s:
        d["m"] = int(s["m"])
    return d


def leg_json(leg):
    return {
        "mode": leg.mode,
        "duration_min": round(leg.duration_min, 1),
        "walk_m": leg.walk_m,
        "fare": leg.fare,
        "wait_min": round(leg.wait_min, 1),
        "source": leg.source,
        "steps": [_step(s) for s in leg.steps],
    }


def item_json(it):
    if it.kind == "lunch":
        return {"kind": "lunch", "arrive": fmt(it.arrive), "leave": fmt(it.leave), "text": it.reason}
    return {
        "kind": "visit",
        "id": it.poi.id,
        "name": it.poi.name,
        "category": it.poi.category,
        "arrive": fmt(it.arrive),
        "leave": fmt(it.leave),
        "dwell": it.dwell,
        "reason": it.reason,
        "ticket": it.poi.ticket,
        "indoor": it.poi.indoor,
        "leg": leg_json(it.leg) if it.leg else None,
    }


def day_json(dp, cfg, pois):
    names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    return {
        "day": dp.day,
        "weekday": names[cfg.weekday_of(dp.day) - 1],
        "start": fmt(cfg.day_start),
        "end": fmt(dp.end_min or cfg.day_start),
        "items": [item_json(i) for i in dp.items],
        "skipped": [pois[p].name for p in dp.skipped if p in pois],
        "poi_count": len(dp.visits),
        "travel": round(dp.travel_min, 1),
        "walk_m": dp.walk_m,
        "ticket": dp.ticket,
        "fare": dp.fare,
    }


def trip_json(trip, pois):
    return {
        "city": trip.city,
        "days": trip.days,
        "metrics": trip.metrics,
        "relaxations": trip.relaxations,
        "feasible": trip.feasible,
        "dayplans": [day_json(dp, trip.cfg, pois) for dp in trip.dayplans],
    }
