"""表达层（模板版）。

真实产品这里换成 LLM：把同一个 leg 结构喂给模型，要求"只允许转述，不许新增
地点/线路/时刻"，生成后再用本文件同款的硬规则回查一遍站名是否都在结构里。

先用模板把"结构化结果 -> 人话"的映射固定下来，好处是：
  - 演示不依赖网络和模型，断网也能跑
  - 后面接 LLM 时，这就是 few-shot 的标准答案
"""

from .models import fmt


def _step_text(s) -> str:
    t = s["type"]
    if t == "walk":
        return s["desc"]
    if t == "wait":
        return f"候车约 {s['min']:.0f} 分钟"
    if t == "metro":
        return f"乘 {s['line']}（{s['direction']}）{s['stops']} 站：{s['board']} → {s['alight']}"
    if t == "bus":
        return f"乘 {s['line']}，{s['board']} → {s['alight']}"
    if t == "transfer":
        return f"在{s['station']}站内换乘 {s['to']}（约 {s['min']:.0f} 分钟）"
    if t == "taxi":
        return s["desc"]
    return s.get("desc", "")


def leg_text(leg) -> str:
    return " → ".join(x for x in (_step_text(s) for s in leg.steps) if x)


def itinerary_text(trip) -> str:
    cfg = trip.cfg
    names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    lines = [f"【{trip.city} · {trip.days} 天行程】"]
    for dp in trip.dayplans:
        wd = names[cfg.weekday_of(dp.day) - 1]
        if not dp.items:
            lines.append(f"\n第 {dp.day} 天（{wd}）：空（没有可安排的景点）")
            continue
        lines.append(f"\n第 {dp.day} 天（{wd}）  {fmt(cfg.day_start)} 出发 · {fmt(dp.end_min)} 收工")
        for it in dp.items:
            if it.kind == "lunch":
                lines.append(f"  {fmt(it.arrive)}–{fmt(it.leave)}  🍜 {it.reason}")
                continue
            if it.leg is not None:
                lines.append(f"    ↓ {leg_text(it.leg)}")
            lines.append(
                f"  {fmt(it.arrive)}–{fmt(it.leave)}  {it.poi.name}（停留 {it.dwell} 分钟）"
            )
            if it.reason:
                lines.append(f"      · {it.reason}")
        if dp.skipped:
            lines.append("    ! 未排入：" + "、".join(dp.skipped))
    return "\n".join(lines)


def summary_text(trip) -> str:
    m = trip.metrics
    return (
        f"景点 {m['poi_count']} 个 · 交通 {m['travel']:.0f} 分钟 · 步行 {m['walk']} 米 · "
        f"等车 {m['wait']:.0f} 分钟 · 车费 ¥{m['fare']:.0f} · 门票 ¥{m['ticket']:.0f} · "
        f"最晚收工 {fmt(m['end'])}"
    )
