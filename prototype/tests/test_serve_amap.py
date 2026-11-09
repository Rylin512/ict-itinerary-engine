"""高德适配层 + 双供应商路由的回归测试（不联网，全部用样例回包）。

    python -m unittest tests.test_serve_amap -v
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import serve  # noqa: E402


class TestAmapUrls(unittest.TestCase):
    def test_route_url_keeps_lng_lat_order(self):
        url = serve.build_amap_route_url("k1", [104.067, 30.572], [104.141, 30.630], "driving")
        self.assertIn("restapi.amap.com/v3/direction/driving", url)
        self.assertIn("origin=104.067000%2C30.572000", url)
        self.assertIn("destination=104.141000%2C30.630000", url)
        self.assertIn("key=k1", url)

    def test_transit_needs_city(self):
        url = serve.build_amap_route_url("k1", [104.0, 30.5], [104.1, 30.6], "transit", "成都")
        self.assertIn("city=", url)
        self.assertIn("cityd=", url)

    def test_missing_key_raises(self):
        with self.assertRaises(ValueError):
            serve.build_amap_route_url("", [104.0, 30.5], [104.1, 30.6])

    def test_place_url(self):
        url = serve.build_amap_place_url("k1", "宽窄巷子", "成都", 10)
        self.assertIn("/v3/place/text", url)
        self.assertIn("keywords=", url)


class TestAmapParse(unittest.TestCase):
    def test_driving_picks_fastest_and_builds_path(self):
        data = {
            "status": "1",
            "route": {"paths": [
                {"distance": "9000", "duration": "1800",
                 "steps": [{"polyline": "104.0,30.5;104.1,30.6"}]},
                {"distance": "12000", "duration": "900",
                 "steps": [{"polyline": "104.0,30.5;104.05,30.55"},
                           {"polyline": "104.05,30.55;104.1,30.6"}]},
            ]},
        }
        out = serve.parse_amap_route(data, "driving")
        self.assertEqual(out["km"], 12.0)
        self.assertEqual(out["min"], 15.0)
        self.assertEqual(out["path"][0], [104.0, 30.5])
        self.assertEqual(out["path"][-1], [104.1, 30.6])

    def test_riding_uses_v4_shape(self):
        data = {"errcode": 0, "data": {"paths": [
            {"distance": "3200", "duration": "900",
             "steps": [{"polyline": "104.0,30.5;104.02,30.52"}]},
        ]}}
        out = serve.parse_amap_route(data, "riding")
        self.assertEqual(out["km"], 3.2)
        self.assertEqual(out["min"], 15.0)

    def test_error_status_raises(self):
        with self.assertRaises(ValueError):
            serve.parse_amap_route({"status": "0", "info": "INVALID_PARAMS"}, "driving")
        with self.assertRaises(ValueError):
            serve.parse_amap_route({"status": "1", "route": {"paths": []}}, "driving")

    def test_place_normalises_fields(self):
        data = {"status": "1", "pois": [
            {"name": "宽窄巷子", "location": "104.0556,30.6636",
             "address": ["四川省", "成都市", "青羊区"], "tel": "028-1", "id": "B0FF", "type": "风景名胜"},
            {"name": "坏数据", "location": ""},
        ]}
        places = serve.parse_amap_place(data)
        self.assertEqual(len(places), 1)
        p = places[0]
        self.assertEqual(p["name"], "宽窄巷子")
        self.assertEqual(p["lng"], 104.0556)
        self.assertEqual(p["lat"], 30.6636)
        self.assertFalse(p["hasNav"])
        self.assertEqual(p["address"], "四川省成都市青羊区")
        self.assertEqual(p["uid"], "amap:B0FF")


class TestDualProvider(unittest.TestCase):
    def test_auto_alternates_start_provider(self):
        with mock.patch.dict(os.environ, {"BAIDU_MAP_AK": "b", "AMAP_MAP_KEY": "a"}, clear=True):
            serve._ALT_STATE[0] = 0
            first = serve._pick_providers("route", "auto", {})
            second = serve._pick_providers("route", "auto", {})
        self.assertEqual(first[0], "baidu")
        self.assertEqual(second[0], "amap")

    def test_place_prefers_amap(self):
        with mock.patch.dict(os.environ, {"BAIDU_MAP_AK": "b", "AMAP_MAP_KEY": "a"}, clear=True):
            serve._ALT_STATE[0] = 0
            order = serve._pick_providers("place", "auto", {})
        self.assertEqual(order[0], "amap")

    def test_explicit_provider_goes_first(self):
        with mock.patch.dict(os.environ, {"BAIDU_MAP_AK": "b", "AMAP_MAP_KEY": "a"}, clear=True):
            self.assertEqual(serve._pick_providers("route", "amap", {})[0], "amap")
            self.assertEqual(serve._pick_providers("place", "baidu", {})[0], "baidu")

    def test_unconfigured_provider_is_skipped(self):
        with mock.patch.dict(os.environ, {"BAIDU_MAP_AK": "b"}, clear=True):
            order = serve._pick_providers("route", "amap", {})
        self.assertEqual(order, ["baidu"])

    def test_route_falls_back_to_second_provider(self):
        body = {"from": [104.0, 30.5], "to": [104.1, 30.6]}
        with mock.patch.dict(os.environ, {"BAIDU_MAP_AK": "b", "AMAP_MAP_KEY": "a"}, clear=True):
            with mock.patch.object(serve, "handle_amap_route", return_value={"ok": False, "error": "quota"}), \
                 mock.patch.object(serve, "handle_baidu_route",
                                   return_value={"ok": True, "km": 5.0, "min": 10.0}):
                out = serve.handle_map_route(dict(body, provider="amap"), {})
        self.assertTrue(out["ok"])
        self.assertEqual(out["provider"], "baidu")

    def test_map_route_reports_all_errors(self):
        body = {"from": [104.0, 30.5], "to": [104.1, 30.6], "provider": "amap"}
        with mock.patch.dict(os.environ, {"BAIDU_MAP_AK": "b", "AMAP_MAP_KEY": "a"}, clear=True):
            with mock.patch.object(serve, "handle_amap_route", return_value={"ok": False, "error": "q"}), \
                 mock.patch.object(serve, "handle_baidu_route", return_value={"ok": False, "error": "k"}):
                out = serve.handle_map_route(body, {})
        self.assertFalse(out["ok"])
        self.assertIn("amap", out["error"])
        self.assertIn("baidu", out["error"])


if __name__ == "__main__":
    unittest.main()
