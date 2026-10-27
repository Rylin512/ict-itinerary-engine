"""独立校验层。

故意不复用编排器自己的判断：从第 1 天的 09:00 重新推一遍时间轴，
逐条检查时间连续性、开放时间、最短停留、每日结束、步行上限、预算。

答辩时可以现场跑这个：评委改任何参数，先跑编排，再跑校验，
"0 违规"比任何解释都管用。
"""

from .models import fmt


def validate(trip, planner) -> list:
    errs = []
    cfg = trip.cfg
    for dp in trip.dayplans:
        weekday = cfg.weekday_of(dp.day)
        t = float(cfg.day_start)
        prev = planner.hotel
        for it in dp.items:
            if it.kind == "lunch":
                if abs(it.arrive - t) > 1:
                    errs.append(f"第{dp.day}天 午餐与上一项时间不连续")
                if it.leave - it.arrive != cfg.lunch_min:
                    errs.append(f"第{dp.day}天 午餐时长异常")
                t = float(it.leave)
                continue

            poi = it.poi
            if weekday in poi.closed_weekdays:
                errs.append(f"第{dp.day}天 {poi.name} 当日闭馆")
            if it.arrive < poi.open_min - 1:
                errs.append(f"第{dp.day}天 {poi.name} 早于开门时间 ({fmt(it.arrive)} < {fmt(poi.open_min)})")
            if it.leave > poi.close_min + 1:
                errs.append(f"第{dp.day}天 {poi.name} 超过闭馆时间")
            if it.leave - it.arrive > poi.max_min + 1:
                errs.append(f"第{dp.day}天 {poi.name} 停留超过上限")

            leg = planner.leg(prev, poi)
            expected = t + leg.duration_min
            if it.arrive < expected - 1.5:
                errs.append(
                    f"第{dp.day}天 {poi.name} 时间倒流：{fmt(it.arrive)} 早于 "
                    f"{fmt(expected)}（漏算路程或等车）"
                )
            if it.leave - it.arrive < poi.min_min - 1 and it.leave < poi.close_min - 1:
                errs.append(f"第{dp.day}天 {poi.name} 停留短于下限")
            t = float(it.leave)
            prev = poi

        if t > cfg.day_end + 1:
            errs.append(f"第{dp.day}天 结束时间 {fmt(t)} 超过 {fmt(cfg.day_end)}")
        if dp.walk_m > cfg.walk_limit_m:
            errs.append(f"第{dp.day}天 步行 {dp.walk_m} 米超上限")

    if trip.metrics.get("ticket", 0) + trip.metrics.get("fare", 0) > cfg.budget + 1:
        errs.append("总花费超预算")
    return errs
