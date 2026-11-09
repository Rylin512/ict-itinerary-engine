"""缓存策略回归：高德路线/地点要写缓存，坐标抖动也要命中同一份。"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import serve  # noqa: E402


class CacheCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old = (serve.CACHE_ENABLED, serve.CACHE_DIR, serve.CACHE_FILE, serve._CACHE)
        serve.CACHE_ENABLED = True
        serve.CACHE_DIR = Path(self.tmp.name)
        serve.CACHE_FILE = Path(self.tmp.name) / "cache.json"
        serve._CACHE = None
        serve._DB = None

    def tearDown(self):
        db = getattr(serve, "_DB", None)
        if db is not None:
            try:
                db.close()
            except Exception:
                pass
        serve.CACHE_ENABLED, serve.CACHE_DIR, serve.CACHE_FILE, serve._CACHE = self.old
        serve._DB = None
        self.tmp.cleanup()


PLACE_DATA = {"status": "1", "pois": [
    {"name": "宽窄巷子", "location": "104.055600,30.663600",
     "address": "青羊区", "id": "B0FF", "type": "风景名胜"},
]}
ROUTE_DATA = {"status": "1", "route": {"paths": [
    {"distance": "3200", "duration": "900",
     "steps": [{"polyline": "104.06,30.66;104.07,30.67"}]},
]}}


class TestAmapCache(CacheCase):
    def test_place_is_cached(self):
        calls = []

        def fake(url, timeout=15):
            calls.append(url)
            return PLACE_DATA, None

        with mock.patch.dict(os.environ, {"AMAP_MAP_KEY": "k"}, clear=True), \
             mock.patch.object(serve, "_amap_request", side_effect=fake):
            first = serve.handle_amap_place({"query": "宽窄巷子", "region": "成都"}, {})
            second = serve.handle_amap_place({"query": " 宽窄巷子 ", "region": "成都"}, {})
        self.assertTrue(first["ok"])
        self.assertEqual(len(calls), 1)
        self.assertTrue(second.get("cached"))
        self.assertEqual(len(second["places"]), 1)

    def test_empty_place_result_not_cached(self):
        calls = []

        def fake(url, timeout=15):
            calls.append(url)
            return {"status": "1", "pois": []}, None

        with mock.patch.dict(os.environ, {"AMAP_MAP_KEY": "k"}, clear=True), \
             mock.patch.object(serve, "_amap_request", side_effect=fake):
            serve.handle_amap_place({"query": "不存在的地方", "region": "成都"}, {})
            serve.handle_amap_place({"query": "不存在的地方", "region": "成都"}, {})
        self.assertEqual(len(calls), 2)

    def test_route_cache_keeps_meter_precision(self):
        """同样的点命中缓存；相差 1e-5（约 1 米）的点必须当成不同路线。"""
        calls = []

        def fake(url, timeout=15):
            calls.append(url)
            return ROUTE_DATA, None

        a1 = {"from": [104.06001, 30.66001], "to": [104.07002, 30.67002], "mode": "driving"}
        a2 = {"from": [104.06002, 30.66001], "to": [104.07002, 30.67002], "mode": "driving"}
        with mock.patch.dict(os.environ, {"AMAP_MAP_KEY": "k"}, clear=True), \
             mock.patch.object(serve, "_amap_request", side_effect=fake):
            first = serve.handle_amap_route(a1, {})
            second = serve.handle_amap_route(a2, {})
            third = serve.handle_amap_route(a1, {})
        self.assertTrue(first["ok"])
        self.assertEqual(len(calls), 2)          # 1 米差 → 不共用缓存
        self.assertFalse(second.get("cached"))
        self.assertTrue(third.get("cached"))     # 完全相同的点 → 命中

    def test_force_bypasses_cache(self):
        calls = []

        def fake(url, timeout=15):
            calls.append(url)
            return ROUTE_DATA, None

        body = {"from": [104.06, 30.66], "to": [104.07, 30.67], "mode": "driving"}
        with mock.patch.dict(os.environ, {"AMAP_MAP_KEY": "k"}, clear=True), \
             mock.patch.object(serve, "_amap_request", side_effect=fake):
            serve.handle_amap_route(body, {})
            serve.handle_amap_route(dict(body, force=True), {})
        self.assertEqual(len(calls), 2)

    def test_unified_route_reuses_result_across_providers(self):
        calls = {"amap": 0, "baidu": 0}

        def fake_amap(url, timeout=15):
            calls["amap"] += 1
            return ROUTE_DATA, None

        def fake_baidu(url, timeout=15, priority=False):
            calls["baidu"] += 1
            return {"status": 0, "result": {"routes": [
                {"distance": 9999, "duration": 999, "steps": []}]}}, None

        body = {"from": [104.06, 30.66], "to": [104.07, 30.67], "mode": "driving"}
        env = {"AMAP_MAP_KEY": "k", "BAIDU_MAP_AK": "b"}
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(serve, "_amap_request", side_effect=fake_amap), \
             mock.patch.object(serve, "_baidu_request", side_effect=fake_baidu):
            first = serve.handle_map_route(dict(body, provider="amap"), {})
            second = serve.handle_map_route(dict(body, provider="baidu"), {})
        self.assertTrue(first["ok"])
        self.assertEqual(calls, {"amap": 1, "baidu": 0})
        self.assertTrue(second.get("cached"))
        self.assertEqual(second["provider"], "amap")
        self.assertEqual(second["km"], 3.2)

    def test_unified_place_reuses_result_across_providers(self):
        calls = {"amap": 0, "baidu": 0}

        def fake_amap(url, timeout=15):
            calls["amap"] += 1
            return PLACE_DATA, None

        def fake_baidu(url, timeout=15, priority=False):
            calls["baidu"] += 1
            return {"status": 0, "results": []}, None

        body = {"query": "宽窄巷子", "region": "成都", "pageSize": 3}
        env = {"AMAP_MAP_KEY": "k", "BAIDU_MAP_AK": "b"}
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(serve, "_amap_request", side_effect=fake_amap), \
             mock.patch.object(serve, "_baidu_request", side_effect=fake_baidu):
            first = serve.handle_map_place(dict(body, provider="amap"), {})
            second = serve.handle_map_place(dict(body, provider="baidu"), {})
        self.assertTrue(first["ok"])
        self.assertEqual(calls, {"amap": 1, "baidu": 0})
        self.assertTrue(second.get("cached"))


if __name__ == "__main__":
    unittest.main()
