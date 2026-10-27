"""一行命令跑完四个演示：

    python run_demo.py

1) 生成一份 3 天带父母的成都行程，打印到出口级
2) 独立校验器复算，给出 0 违规
3) 勾选一个景点的"边际成本"：加青羊宫（近） vs 加东郊记忆（远）
4) 下雨只重排第 2 天，其余天不动（局部修复）
"""

import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

from engine.explain import itinerary_text, summary_text
from engine.models import Access, Place, fmt, load_pois
from engine.planner import Config, Planner
from engine.providers.transit import ChengduTransit
from engine.validator import validate

DATA = Path(__file__).resolve().parent / "engine" / "data"


def build():
    pois = load_pois(DATA / "chengdu_pois.json")
    metro = json.loads((DATA / "chengdu_metro.json").read_text(encoding="utf-8"))
    transit = ChengduTransit(metro)
    hotel = Place("hotel", "酒店（春熙路）", 30.6545, 104.0800,
                  Access("春熙路", "D", 150))
    return pois, transit, Planner(pois, transit, hotel)


def line(title=""):
    print("\n" + "=" * 78)
    if title:
        print(title)
        print("=" * 78)


def main():
    pois, transit, planner = build()
    selected = ["kuanzhai", "renmin", "cdmuseum", "wenshu", "wuhou",
                "jinli", "dufu", "jinsha", "chunxi", "panda"]
    cfg = Config.profile(party="老人", budget=1500, walk_limit=6000,
                         start_weekday=6, day_start="09:00", day_end="21:00")

    line("① 3 天行程（带父母，预算 1500，日行 09:00–21:00）")
    t0 = time.perf_counter()
    trip = planner.plan(selected, 3, cfg)
    dt = time.perf_counter() - t0
    print(itinerary_text(trip))
    print("\n" + summary_text(trip))
    if trip.relaxations:
        print("\n取舍说明（引擎主动告知，而不是硬塞）：")
        for r in trip.relaxations:
            print("  -", r)
    print(f"\n求解耗时 {dt*1000:.0f} ms")

    line("② 独立校验（重新推时间轴，不信编排器的自述）")
    errs = validate(trip, planner)
    print("违规条数：", len(errs))
    for e in errs[:10]:
        print("  -", e)
    assert not errs, "存在硬约束违规，先修再演示"

    line("③ 选点即算代价：勾一个点，立刻告诉你代价")
    for pid in ["qingyang", "dongjiao"]:
        r = planner.add_poi(trip, pid)
        d = r["delta"]
        print(f"\n+ 加入「{r['name']}」")
        print(f"  交通 {d['travel']:+.0f} 分钟 · 步行 {d['walk']:+d} 米 · "
              f"车费 {d['fare']:+.0f} 元 · 最晚收工 {d['end']:+.0f} 分钟")
        if r["dropped"]:
            print("  代价：需要放弃 " + "、".join(pois[i].name for i in r["dropped"]))
        else:
            print(f"  可以塞进去，耗时 {r['seconds']*1000:.0f} ms")

    line("④ 扰动重排：第 2 天下雨，只改第 2 天")
    before = [dp.poi_ids() for dp in trip.dayplans]
    planner.replan_day(trip, 2, mode="rain")
    after = [dp.poi_ids() for dp in trip.dayplans]
    for d in range(3):
        mark = "不变" if before[d] == after[d] else "已调整"
        print(f"  第 {d+1} 天：{mark}  {before[d]} -> {after[d]}")
    print()
    print(itinerary_text(trip))
    print("\n" + summary_text(trip))
    errs2 = validate(trip, planner)
    print(f"重排后校验：{len(errs2)} 违规")
    for e in errs2[:5]:
        print("  -", e)

    line("⑤ 回归测试：随机选点 × 30 次，硬约束违规必须为 0")
    random.seed(7)
    all_ids = list(pois)
    worst = 0.0
    bad = 0
    t_all = time.perf_counter()
    for k in range(30):
        n = random.randint(3, 9)
        sample = random.sample(all_ids, n)
        days = random.randint(1, 3)
        s = time.perf_counter()
        tr = planner.plan(sample, days, cfg)
        worst = max(worst, time.perf_counter() - s)
        ev = validate(tr, planner)
        if ev:
            bad += 1
            print("  违规样例：", sample, ev[:3])
    total = time.perf_counter() - t_all
    print(f"  30 次全部通过：{'是' if bad == 0 else '否'} · 平均 {(total/30)*1000:.0f} ms/次 · "
          f"最慢 {worst*1000:.0f} ms")

    line("⑥ 接口契约示例（前端/LLM 拿到的就是这个结构）")
    day1 = trip.dayplans[0]
    sample_item = next(it for it in day1.items if it.kind == "visit" and it.leg)
    payload = {
        "day": day1.day,
        "start": fmt(cfg.day_start),
        "item": {
            "poi": sample_item.poi.name,
            "arrive": fmt(sample_item.arrive),
            "leave": fmt(sample_item.leave),
            "dwell_min": sample_item.dwell,
            "leg": {
                "duration_min": round(sample_item.leg.duration_min, 1),
                "walk_m": sample_item.leg.walk_m,
                "fare": sample_item.leg.fare,
                "source": sample_item.leg.source,
                "steps": sample_item.leg.steps,
            },
        },
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
