"""回归测试：不测 UI，只测"敢不敢上线"的三件事。

    python -m unittest discover -s tests -t . -v
"""

import json
import os
import random
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.explain import itinerary_text
from engine.models import Access, Place, load_pois
from engine.planner import Config, Planner
from engine.providers.transit import ChengduTransit
from engine.validator import validate

DATA = ROOT / "engine" / "data"


def build():
    import json
    pois = load_pois(DATA / "chengdu_pois.json")
    metro = json.loads((DATA / "chengdu_metro.json").read_text(encoding="utf-8"))
    hotel = Place("hotel", "酒店（春熙路）", 30.6545, 104.0800, Access("春熙路", "D", 150))
    planner = Planner(pois, ChengduTransit(metro), hotel)
    return pois, planner


class TestEngine(unittest.TestCase):
    def setUp(self):
        self.pois, self.planner = build()
        self.cfg = Config.profile(party="老人", budget=1500, walk_limit=6000,
                                  start_weekday=6, day_start="09:00", day_end="21:00")

    def test_random_plans_are_feasible(self):
        """任意选点组合，排出来的行程都必须过独立校验。"""
        random.seed(11)
        ids = list(self.pois)
        for _ in range(12):
            sample = random.sample(ids, random.randint(2, 9))
            trip = self.planner.plan(sample, random.randint(1, 3), self.cfg)
            self.assertEqual(validate(trip, self.planner), [], f"输入 {sample}")

    def test_validator_is_not_vacuous(self):
        """故意把一条行程改坏，校验器必须能抓到——否则前面的 0 违规没有意义。"""
        trip = self.planner.plan(["wuhou", "jinli", "jinsha"], 1, self.cfg)
        self.assertEqual(validate(trip, self.planner), [])
        item = next(it for it in trip.dayplans[0].items if it.kind == "visit")
        item.arrive -= 40          # 时间倒流
        self.assertTrue(validate(trip, self.planner))

    def test_marginal_cost_is_incremental(self):
        """加一个点：不动其它天，只改一天；代价要能算出来。"""
        trip = self.planner.plan(["wuhou", "jinli", "cdmuseum", "renmin", "chunxi"], 2, self.cfg)
        before = [dp.poi_ids() for dp in trip.dayplans]
        res = self.planner.add_poi(trip, "panda")
        self.assertIsNotNone(res)
        self.assertIn("travel", res["delta"])
        changed = [d for d in range(len(before))
                   if before[d] != res["trip"].dayplans[d].poi_ids()]
        self.assertLessEqual(len(changed), 1, "加一个点不应该把两天都重排")

    def test_text_contains_exit_level_detail(self):
        """出口级描述不能退化成"坐地铁去某地"。"""
        trip = self.planner.plan(["wuhou", "jinli", "jinsha"], 1, self.cfg)
        text = itinerary_text(trip)
        self.assertIn("号线", text)
        self.assertRegex(text, r"[A-Z]?\d?\s?口")

    def test_http_contract(self):
        """前端只认 serve.py 的 JSON 契约（现为 LLM / 百度代理），这里把它一起测了。"""
        from serve import ai_config, baidu_ready, handle_baidu_driving, handle_llm

        # LLM 代理：参数缺失/非法上游 → 归一化的 ok:false，绝不 500
        self.assertFalse(handle_llm({}, {})["ok"])
        bad = handle_llm({"baseURL": "https://evil.example.com", "model": "m",
                          "messages": [{"role": "user", "content": "x"}]}, {})
        self.assertFalse(bad["ok"])
        self.assertIn("白名单", bad["error"])

        # 百度代理：无 AK / 坐标非法 → 归一化的 ok:false
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(handle_baidu_driving({"from": [104.0, 30.0], "to": [104.1, 30.6]}, {})["ok"])
        self.assertFalse(handle_baidu_driving({"from": "x"}, {"X-Baidu-Ak": "ak"})["ok"])

        # 渠道探测：只报 ready 布尔，不回传 key 内容
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-secret-xyz"}, clear=True):
            cfg = ai_config()
            self.assertFalse(baidu_ready())
        self.assertNotIn("sk-secret-xyz", json.dumps(cfg, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
