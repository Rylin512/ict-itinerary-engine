"""serve.py 百度路线代理的回归测试：AK 解析 / URL 构造 / 响应解析。

    python -m unittest discover -s tests -t . -v
"""

import json
import os
import sys
import threading
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import serve  # noqa: E402


class TestBaiduAk(unittest.TestCase):
    def test_header_wins_over_env(self):
        with mock.patch.dict(os.environ, {"BAIDU_MAP_AK": "env-ak"}):
            self.assertEqual(serve.resolve_baidu_ak("header-ak"), "header-ak")
            self.assertEqual(serve.resolve_baidu_ak(None), "env-ak")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(serve.resolve_baidu_ak(None))

    def test_ready(self):
        with mock.patch.dict(os.environ, {"BAIDU_MAP_AK": "x-ak"}):
            self.assertTrue(serve.baidu_ready())
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(serve.baidu_ready())


class TestBuildUrl(unittest.TestCase):
    def test_builds_url_with_gcj02(self):
        # 入参 [lng, lat]（页面坐标系），百度要求 origin/destination 为 lat,lng，应换序
        url = serve.build_baidu_driving_url("ak-1", [104.067, 30.572], [104.141, 30.630])
        self.assertIn("https://api.map.baidu.com/direction/v2/driving?", url)
        self.assertIn("origin=30.572000,104.067000", url)
        self.assertIn("destination=30.630000,104.141000", url)
        self.assertIn("coord_type=gcj02", url)
        self.assertIn("ak=ak-1", url)

    def test_rejects_bad_coords_and_missing_ak(self):
        with self.assertRaises(ValueError):
            serve.build_baidu_driving_url("ak", ["abc", 30.0], [104.0, 30.6])
        with self.assertRaises(ValueError):
            serve.build_baidu_driving_url("ak", [999.0, 30.0], [104.0, 30.6])
        with self.assertRaises(ValueError):
            serve.build_baidu_driving_url(None, [104.0, 30.0], [104.1, 30.6])
        with self.assertRaises(ValueError):
            serve.build_baidu_driving_url("ak", [], [104.1, 30.6])


class TestParseResponse(unittest.TestCase):
    def test_parses_km_and_min(self):
        out = serve.parse_baidu_driving({
            "status": 0,
            "result": {"routes": [{"distance": 12340, "duration": 1500}]},
        })
        self.assertAlmostEqual(out["km"], 12.34)
        self.assertAlmostEqual(out["min"], 25.0)

    def test_error_status_and_empty_routes(self):
        with self.assertRaises(ValueError):
            serve.parse_baidu_driving({"status": 2, "message": "参数错误"})
        with self.assertRaises(ValueError):
            serve.parse_baidu_driving({"status": 0, "result": {"routes": []}})
        with self.assertRaises(ValueError):
            serve.parse_baidu_driving({"status": 0})


class TestBaiduPlace(unittest.TestCase):
    def test_builds_place_url_with_gcj02_and_scope2(self):
        url = serve.build_baidu_place_url("ak-1", "宽窄巷子 酒店", "成都", page_size=5, page_num=1)
        self.assertIn("https://api.map.baidu.com/place/v2/search?", url)
        self.assertIn("scope=2", url)  # 要详情才带 navi_location
        self.assertIn("ret_coordtype=gcj02ll", url)  # 与页面数据同坐标系
        self.assertIn("page_size=5", url)
        self.assertIn("page_num=1", url)
        self.assertIn("%E5%AE%BD%E7%AA%84%E5%B7%B7%E5%AD%90", url)  # query 已编码
        self.assertIn("region=%E6%88%90%E9%83%BD", url)

    def test_clamps_page_size_and_rejects_bad_input(self):
        self.assertIn("page_size=20", serve.build_baidu_place_url("ak", "酒店", "成都", page_size=999))
        self.assertIn("page_size=1", serve.build_baidu_place_url("ak", "酒店", "成都", page_size=0))
        with self.assertRaises(ValueError):
            serve.build_baidu_place_url(None, "酒店", "成都")
        with self.assertRaises(ValueError):
            serve.build_baidu_place_url("ak", "  ", "成都")
        with self.assertRaises(ValueError):
            serve.build_baidu_place_url("ak", "酒店", "")

    def test_parse_prefers_navi_location(self):
        data = {"status": 0, "results": [
            {
                "name": "成都宽窄巷子", "address": "青羊区长顺街",
                "location": {"lng": 104.055, "lat": 30.669},
                "detail_info": {"navi_location": {"lng": 104.0575, "lat": 30.6698},
                                "tag": "旅游景点", "phone": "028-1"},
                "uid": "u1",
            },
            {
                "name": "某酒店", "address": "青羊区某路",
                "location": {"lng": 104.06, "lat": 30.67},
            },
            {"name": "没有坐标", "address": "x"},
        ]}
        places = serve.parse_baidu_place(data)
        self.assertEqual(len(places), 2)  # 无坐标的条目被丢弃
        self.assertTrue(places[0]["hasNav"])
        self.assertAlmostEqual(places[0]["navLng"], 104.0575)
        self.assertAlmostEqual(places[0]["navLat"], 30.6698)
        self.assertEqual(places[0]["tag"], "旅游景点")
        self.assertEqual(places[0]["tel"], "028-1")
        self.assertFalse(places[1]["hasNav"])
        self.assertAlmostEqual(places[1]["navLng"], 104.06)  # 回退到地址坐标

    def test_parse_error_status(self):
        with self.assertRaises(ValueError):
            serve.parse_baidu_place({"status": 302, "message": "配额超限"})


class TestBaiduSuggestAndDetail(unittest.TestCase):
    def test_suggest_url_is_fuzzy_search_with_gcj02(self):
        url = serve.build_baidu_suggest_url("ak-1", "春熙路 全季", "成都")
        self.assertIn("https://api.map.baidu.com/place/v2/suggestion?", url)
        self.assertIn("ret_coordtype=gcj02ll", url)  # 只写 gcj02 会回 BD-09
        self.assertIn("city_limit=true", url)
        self.assertIn("region=%E6%88%90%E9%83%BD", url)
        self.assertIn("%E6%98%A5%E7%86%99%E8%B7%AF", url)
        # 也允许不限定城市（用户跨城找酒店时仍能出结果）
        no_region = serve.build_baidu_suggest_url("ak", "全季酒店", "")
        self.assertNotIn("region=", no_region)
        self.assertNotIn("city_limit=", no_region)

    def test_suggest_rejects_missing_input(self):
        with self.assertRaises(ValueError):
            serve.build_baidu_suggest_url(None, "酒店", "成都")
        with self.assertRaises(ValueError):
            serve.build_baidu_suggest_url("ak", "   ", "成都")

    def test_detail_url_requests_navi_location(self):
        url = serve.build_baidu_detail_url("ak-1", "uid 1")
        self.assertIn("https://api.map.baidu.com/place/v2/detail?", url)
        self.assertIn("uid=uid%201", url)
        self.assertIn("scope=2", url)
        self.assertIn("ret_coordtype=gcj02ll", url)
        with self.assertRaises(ValueError):
            serve.build_baidu_detail_url("ak", "")
        with self.assertRaises(ValueError):
            serve.build_baidu_detail_url(None, "uid")

    def test_parse_suggest_returns_candidates(self):
        data = {"status": 0, "result": [
            {"name": "全季酒店(春熙路店)", "address": "东大街",
             "location": {"lng": 104.08, "lat": 30.65}, "uid": "u1", "tag": "酒店"},
            {"name": "没有坐标"},
        ]}
        places = serve.parse_baidu_suggest(data)
        self.assertEqual(len(places), 1)
        self.assertEqual(places[0]["uid"], "u1")
        self.assertFalse(places[0]["hasNav"])  # suggestion 没有 navi_location
        self.assertAlmostEqual(places[0]["lng"], 104.08)

    def test_parse_suggest_falls_back_to_city_district(self):
        data = {"status": 0, "result": [
            {"name": "某酒店", "city": "成都市", "district": "锦江区",
             "location": {"lng": 104.08, "lat": 30.65}, "uid": "u1"}]}
        self.assertEqual(serve.parse_baidu_suggest(data)[0]["address"], "成都市锦江区")

    def test_parse_detail_accepts_dict_or_list(self):
        item = {"name": "全季酒店", "address": "东大街",
                "location": {"lng": 104.08, "lat": 30.65},
                "detail_info": {"navi_location": {"lng": 104.081, "lat": 30.651}}}
        for result in (item, [item]):
            place = serve.parse_baidu_detail({"status": 0, "result": result})
            self.assertTrue(place["hasNav"])
            self.assertAlmostEqual(place["navLng"], 104.081)
            self.assertAlmostEqual(place["navLat"], 30.651)

    def test_parse_detail_errors(self):
        with self.assertRaises(ValueError):
            serve.parse_baidu_detail({"status": 2, "message": "参数错误"})
        with self.assertRaises(ValueError):
            serve.parse_baidu_detail({"status": 0, "result": []})
        with self.assertRaises(ValueError):
            serve.parse_baidu_detail({"status": 0, "result": {"name": "无坐标"}})

    def test_suggest_and_detail_handlers_use_priority_gate(self):
        suggest = {"status": 0, "result": [
            {"name": "酒店", "location": {"lng": 104.0, "lat": 30.0}, "uid": "u1"}]}
        with mock.patch("serve._baidu_request", return_value=(suggest, None)) as req:
            out = serve.handle_baidu_suggest({"query": "酒店", "region": "成都"},
                                             {"X-Baidu-Ak": "ak"})
            self.assertEqual(req.call_args.kwargs.get("priority"), True)
        self.assertTrue(out["ok"])
        self.assertEqual(out["places"][0]["uid"], "u1")

        detail = {"status": 0, "result": {
            "name": "酒店", "location": {"lng": 104.0, "lat": 30.0},
            "detail_info": {"navi_location": {"lng": 104.001, "lat": 30.001}}}}
        with mock.patch("serve._baidu_request", return_value=(detail, None)) as req:
            out = serve.handle_baidu_detail({"uid": "u1"}, {"X-Baidu-Ak": "ak"})
            self.assertEqual(req.call_args.kwargs.get("priority"), True)
        self.assertTrue(out["ok"])
        self.assertTrue(out["place"]["hasNav"])

    def test_place_handler_also_priority(self):
        with mock.patch("serve._baidu_request", return_value=({"status": 0, "results": []}, None)) as req:
            serve.handle_baidu_place({"query": "酒店", "region": "成都"}, {"X-Baidu-Ak": "ak"})
        self.assertEqual(req.call_args.kwargs.get("priority"), True)

    def test_priority_gate_takes_next_slot_before_normal(self):
        order = []
        with mock.patch.object(serve, "BAIDU_MIN_INTERVAL", 0.05):
            with serve._BAIDU_GATE:
                serve._BAIDU_LAST_CALL[0] = time.monotonic() + 0.5

            def worker(tag, priority):
                serve.baidu_gate(priority)
                order.append(tag)

            normal = threading.Thread(target=worker, args=("normal", False))
            normal.start()
            deadline = time.monotonic() + 1.0
            while serve._BAIDU_WAITING["normal"] == 0 and time.monotonic() < deadline:
                time.sleep(0.005)
            priority = threading.Thread(target=worker, args=("priority", True))
            priority.start()
            while serve._BAIDU_WAITING["priority"] == 0 and time.monotonic() < deadline:
                time.sleep(0.005)
            normal.join(3)
            priority.join(3)
        self.assertEqual(order, ["priority", "normal"])


class TestBaiduRouteModes(unittest.TestCase):
    def test_each_mode_hits_its_endpoint(self):
        for mode in ("driving", "walking", "riding"):
            url = serve.build_baidu_route_url("ak", [104.0, 30.0], [104.1, 30.6], mode)
            self.assertIn(f"direction/v2/{mode}?", url)
            self.assertIn("coord_type=gcj02", url)
            self.assertIn("ret_coordtype=gcj02", url)
        transit = serve.build_baidu_route_url(
            "ak", [104.0, 30.0], [106.5, 29.5], "transit", city1="成都", city2="重庆")
        self.assertIn("direction/v2/transit?", transit)
        self.assertIn("city1=%E6%88%90%E9%83%BD", transit)
        self.assertIn("city2=%E9%87%8D%E5%BA%86", transit)

    def test_transit_requires_cities_and_mode_validated(self):
        with self.assertRaises(ValueError):
            serve.build_baidu_route_url("ak", [104.0, 30.0], [104.1, 30.6], "transit")
        with self.assertRaises(ValueError):
            serve.build_baidu_route_url("ak", [104.0, 30.0], [104.1, 30.6], "flying")

    def test_parse_concatenates_step_paths(self):
        data = {"status": 0, "result": {"origin": {"lng": 104.0, "lat": 30.0},
                "destination": {"lng": 104.1, "lat": 30.6},
                "routes": [{"distance": 1200, "duration": 180, "price": 3, "steps": [
                    {"path": "104.0,30.0;104.05,30.3"},
                    {"path": "104.05,30.3;104.1,30.6"},
                ]}]}}
        out = serve.parse_baidu_route(data, "driving")
        self.assertAlmostEqual(out["km"], 1.2)
        self.assertAlmostEqual(out["min"], 3.0)
        self.assertEqual(out["cost"], 3.0)
        # 拼接、去重后是 3 个点，不是点到点直线
        self.assertEqual(out["path"], [[104.0, 30.0], [104.05, 30.3], [104.1, 30.6]])

    def test_parse_nested_transit_paths_and_fallback(self):
        data = {"status": 0, "result": {"routes": [{"distance": 5000, "duration": 900, "steps": [
            [{"path": "104.0,30.0;104.1,30.1"}, {"walk_type": 1}],
            [{"path": "104.1,30.1;104.2,30.2"}],
        ]}]}}
        out = serve.parse_baidu_route(data, "transit")
        self.assertEqual(out["path"], [[104.0, 30.0], [104.1, 30.1], [104.2, 30.2]])
        self.assertNotIn("cost", out)

        fallback = serve.parse_baidu_route({"status": 0, "result": {
            "origin": {"lng": 104.0, "lat": 30.0},
            "destination": {"lng": 104.1, "lat": 30.6},
            "routes": [{"distance": 10, "duration": 10}]}}, "walking")
        self.assertEqual(fallback["path"], [[104.0, 30.0], [104.1, 30.6]])

    def test_path_is_thinned(self):
        pts = ";".join(f"{104 + i / 10000:.4f},{30 + i / 10000:.4f}" for i in range(3000))
        out = serve.parse_baidu_route({"status": 0, "result": {"routes": [
            {"distance": 1, "duration": 1, "steps": [{"path": pts}]}]}})
        self.assertLessEqual(len(out["path"]), serve.MAX_PATH_POINTS)
        self.assertEqual(out["path"][0], [104.0, 30.0])
        self.assertEqual(out["path"][-1], [104 + 2999 / 10000, 30 + 2999 / 10000])


class TestBaiduHandlers(unittest.TestCase):
    def test_place_handler_missing_ak(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            out = serve.handle_baidu_place({"query": "酒店", "region": "成都"}, {})
        self.assertFalse(out["ok"])
        self.assertIn("AK", out["error"])

    def test_route_handler_missing_cities_for_transit(self):
        out = serve.handle_baidu_route(
            {"from": [104.0, 30.0], "to": [104.1, 30.6], "mode": "transit"},
            {"X-Baidu-Ak": "ak"})
        self.assertFalse(out["ok"])
        self.assertIn("city", out["error"])

    def test_place_handler_returns_places(self):
        payload = json.dumps({"status": 0, "results": [
            {"name": "酒店", "location": {"lng": 104.0, "lat": 30.0}}]}).encode()

        class FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return payload

        with mock.patch("serve.urllib.request.urlopen", return_value=FakeResp()):
            out = serve.handle_baidu_place({"query": "酒店", "region": "成都"}, {"X-Baidu-Ak": "ak"})
        self.assertTrue(out["ok"])
        self.assertEqual(out["places"][0]["name"], "酒店")


class TestTileProxy(unittest.TestCase):
    def test_parses_valid_tile_path(self):
        self.assertEqual(serve.parse_tile_path("/api/tiles/5/26/12.png"), (5, 26, 12))
        self.assertEqual(serve.parse_tile_path("/api/tiles/0/0/0.png"), (0, 0, 0))

    def test_rejects_bad_tile_paths(self):
        for p in ("/api/tiles/5/26.png", "/api/tiles/a/1/2.png",
                  "/api/tiles/5/-1/2.png", "/api/tiles/19/0/0.png",
                  "/api/tiles/3/99/0.png", "/other"):
            self.assertIsNone(serve.parse_tile_path(p), p)


class TestBaiduConfig(unittest.TestCase):
    def test_browser_ak_exposed_only_when_configured(self):
        with mock.patch.dict(os.environ, {"BAIDU_BROWSER_AK": "b-ak"}, clear=True):
            cfg = serve.baidu_config()
            self.assertEqual(cfg["browserAK"], "b-ak")
            self.assertFalse(cfg["ready"])
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(serve.baidu_config()["browserAK"], "")

    def test_config_reports_ready_and_interval(self):
        with mock.patch.dict(os.environ, {"BAIDU_MAP_AK": "s-ak"}, clear=True):
            cfg = serve.baidu_config()
        self.assertTrue(cfg["ready"])
        self.assertEqual(cfg["browserAK"], "")
        self.assertGreaterEqual(cfg["minInterval"], 500)


class TestHandler(unittest.TestCase):
    def test_missing_ak_returns_ok_false(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            out = serve.handle_baidu_driving({"from": [104.0, 30.0], "to": [104.1, 30.6]}, {})
        self.assertFalse(out["ok"])
        self.assertIn("AK", out["error"])

    def test_bad_body_returns_ok_false(self):
        out = serve.handle_baidu_driving({"from": "x"}, {"X-Baidu-Ak": "ak"})
        self.assertFalse(out["ok"])

    def test_upstream_error_mapped(self):
        class FakeHTTPError(urllib.error.HTTPError):
            def __init__(self):
                super().__init__("url", 401, "denied", None, None)
        with mock.patch("serve.build_baidu_driving_url", return_value="https://x"), \
             mock.patch("serve.urllib.request.urlopen", side_effect=FakeHTTPError()):
            out = serve.handle_baidu_driving({"from": [104.0, 30.0], "to": [104.1, 30.6]}, {"X-Baidu-Ak": "ak"})
        self.assertFalse(out["ok"])
        self.assertIn("401", out["error"])


if __name__ == "__main__":
    unittest.main()
