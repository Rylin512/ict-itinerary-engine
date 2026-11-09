"""serve.py 百度路线代理的回归测试：AK 解析 / URL 构造 / 响应解析。

    python -m unittest discover -s tests -t . -v
"""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import serve  # noqa: E402

# 单测不读本机真实缓存，避免请求命中缓存后跳过 mock 上游
serve.CACHE_ENABLED = False


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

    def test_parse_transit_segments(self):
        data = {"status": 0, "result": {"routes": [{
            "distance": 12903, "duration": 3314, "price": 2, "steps": [
                [{"distance": 318, "duration": 272, "instructions": "步行318米",
                  "start_location": {"lng": 104.0722, "lat": 30.6560},
                  "end_location": {"lng": 104.0710, "lat": 30.6571},
                  "vehicle_info": {"type": 5, "detail": None}}],
                [{"distance": 12268, "duration": 2171,
                  "instructions": "盐市口站乘夜间9路经过20站到高新区孵化园站",
                  "start_location": {"lng": 104.0710, "lat": 30.6571},
                  "end_location": {"lng": 104.0681, "lat": 30.5730},
                  "vehicle_info": {"type": 3, "detail": {
                      "name": "夜间9路", "stop_num": 20,
                      "on_station": "盐市口站", "off_station": "高新区孵化园站"}}}],
                [{"distance": 317, "duration": 271, "instructions": "步行317米",
                  "vehicle_info": {"type": 5, "detail": None}}],
            ]}]}}
        out = serve.parse_baidu_route(data, "transit")
        self.assertEqual(out["cost"], 2.0)
        self.assertEqual([s["mode"] for s in out["segments"]], ["walk", "transit", "walk"])
        ride = out["segments"][1]
        self.assertEqual(ride["name"], "夜间9路")
        self.assertEqual(ride["stops"], 20)
        self.assertEqual(ride["fromName"], "盐市口站")
        self.assertEqual(ride["from"], [104.071, 30.6571])
        self.assertAlmostEqual(ride["km"], 12.27)
        # 非公交路线不展开 segments（避免驾车逐条指令把回包撑大）
        self.assertNotIn("segments", serve.parse_baidu_route(
            {"status": 0, "result": {"routes": [
                {"distance": 1, "duration": 1, "steps": [{"path": "104.0,30.0;104.1,30.1"}]}]}},
            "driving"))

    def test_transit_uses_one_line_per_transfer_group(self):
        data = {"status": 0, "result": {"routes": [{
            "distance": 3000, "duration": 600, "steps": [[
                {"distance": 1500, "duration": 300, "path": "104.0,30.0;104.1,30.1",
                 "vehicle_info": {"detail": {"name": "47路"}}},
                {"distance": 1500, "duration": 300, "path": "104.5,30.5;104.6,30.6",
                 "vehicle_info": {"detail": {"name": "J103路"}}},
            ]]}]}}
        out = serve.parse_baidu_route(data, "transit")
        # 只保留推荐线路的折线，不能把备选线路也拼进来（否则会折返）
        self.assertEqual(out["path"], [[104.0, 30.0], [104.1, 30.1]])
        self.assertEqual([s["name"] for s in out["segments"]], ["47路"])

    def test_transit_missing_path_falls_back_to_start_end(self):
        data = {"status": 0, "result": {"routes": [{
            "distance": 2000, "duration": 500, "steps": [[{
                "distance": 2000, "duration": 500,
                "start_location": {"lng": 104.0, "lat": 30.0},
                "end_location": {"lng": 104.1, "lat": 30.1},
                "vehicle_info": {"detail": {"name": "测试公交"}},
            }]]}]}}
        out = serve.parse_baidu_route(data, "transit")
        self.assertEqual(out["path"], [[104.0, 30.0], [104.1, 30.1]])

    def test_picks_fastest_alternative(self):
        data = {"status": 0, "result": {"routes": [
            {"distance": 1000, "duration": 600, "steps": [{"path": "104.0,30.0;104.1,30.1"}]},
            {"distance": 2000, "duration": 300, "steps": [{"path": "104.0,30.0;104.2,30.2"}]},
        ]}}
        out = serve.parse_baidu_route(data, "driving")
        self.assertAlmostEqual(out["min"], 5.0)
        self.assertAlmostEqual(out["km"], 2.0)
        self.assertEqual(out["path"], [[104.0, 30.0], [104.2, 30.2]])

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


class TestBaiduCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old = (serve.CACHE_ENABLED, serve.CACHE_DIR, serve.CACHE_FILE, serve._CACHE)
        serve.CACHE_ENABLED = True
        serve.CACHE_DIR = Path(self.tmp.name)
        serve.CACHE_FILE = Path(self.tmp.name) / "baidu.json"
        serve._CACHE = None

    def tearDown(self):
        # Windows 下 sqlite 连接不关掉会锁住临时目录，先关再删
        if serve._CACHE is not None:
            try:
                serve._CACHE.close()
            except Exception:
                pass
        serve.CACHE_ENABLED, serve.CACHE_DIR, serve.CACHE_FILE, serve._CACHE = self.old
        self.tmp.cleanup()

    def test_route_cache_skips_second_upstream_call(self):
        fake = {
            "status": 0,
            "result": {
                "origin": {"lng": 104.0, "lat": 30.0},
                "destination": {"lng": 104.1, "lat": 30.1},
                "routes": [{
                    "distance": 1200, "duration": 300,
                    "steps": [{"path": "104.0,30.0;104.05,30.05;104.1,30.1"}],
                }],
            },
        }
        body = {"from": [104.0, 30.0], "to": [104.1, 30.1], "mode": "driving"}
        with mock.patch("serve._baidu_request", return_value=(fake, None)) as req:
            first = serve.handle_baidu_route(body, {"X-Baidu-Ak": "ak"})
            second = serve.handle_baidu_route(body, {"X-Baidu-Ak": "ak"})
        self.assertTrue(first["ok"])
        self.assertEqual(req.call_count, 1)
        self.assertTrue(second["cached"])
        self.assertEqual(second["km"], first["km"])

    def test_force_bypasses_route_cache(self):
        fake = {
            "status": 0,
            "result": {"routes": [{
                "distance": 1000, "duration": 200,
                "steps": [{"path": "104.0,30.0;104.1,30.1"}],
            }]},
        }
        body = {"from": [104.0, 30.0], "to": [104.1, 30.1], "mode": "driving"}
        with mock.patch("serve._baidu_request", return_value=(fake, None)) as req:
            serve.handle_baidu_route(body, {"X-Baidu-Ak": "ak"})
            serve.handle_baidu_route({**body, "force": True}, {"X-Baidu-Ak": "ak"})
        self.assertEqual(req.call_count, 2)


class TestTransitSmoothing(unittest.TestCase):
    def _data(self, path):
        return {
            "status": 0,
            "result": {"routes": [{
                "distance": 9000, "duration": 1800,
                "steps": [[{
                    "trans_type": -1, "distance": 8800, "duration": 1200,
                    "path": path,
                    "vehicle_info": {"detail": {"name": "测试公交"}},
                }]],
            }]},
        }

    def test_sparse_vehicle_segment_gets_road_geometry(self):
        driving = {
            "status": 0,
            "result": {"routes": [{
                "distance": 9000, "duration": 1000,
                "steps": [{"path": "104.00,30.00;104.02,30.01;104.04,30.03;104.06,30.04"}],
            }]},
        }
        with mock.patch("serve._baidu_request", return_value=(driving, None)) as req:
            out = serve.smooth_transit_path(self._data("104.00,30.00;104.06,30.04"), "ak")
        self.assertIsNotNone(out)
        self.assertGreater(len(out), 2)
        self.assertEqual(req.call_count, 1)

    def test_dense_walking_segment_untouched(self):
        with mock.patch("serve._baidu_request") as req:
            out = serve.smooth_transit_path(self._data("104.00,30.00;104.001,30.001"), "ak")
        self.assertIsNone(out)
        req.assert_not_called()

    def test_missing_vehicle_path_gets_road_geometry(self):
        data = {
            "status": 0,
            "result": {"routes": [{
                "distance": 5000, "duration": 900, "steps": [[{
                    "distance": 5000, "duration": 900,
                    "start_location": {"lng": 104.00, "lat": 30.00},
                    "end_location": {"lng": 104.06, "lat": 30.04},
                    "vehicle_info": {"detail": {"name": "测试公交"}},
                }]],
            }]},
        }
        driving = {
            "status": 0,
            "result": {"routes": [{
                "distance": 5200, "duration": 700,
                "steps": [{"path": "104.00,30.00;104.03,30.02;104.06,30.04"}],
            }]},
        }
        with mock.patch("serve._baidu_request", return_value=(driving, None)) as req:
            out = serve.smooth_transit_path(data, "ak")
        self.assertIsNotNone(out)
        self.assertIn([104.03, 30.02], out)
        self.assertEqual(req.call_count, 1)

    def test_gap_between_steps_is_filled(self):
        data = {"status": 0, "result": {"routes": [{
            "distance": 8000, "duration": 1200, "steps": [
                [{"distance": 100, "duration": 80,
                  "path": "104.000,30.000;104.001,30.000",
                  "vehicle_info": {"detail": None}}],
                [{"distance": 100, "duration": 80,
                  "path": "104.060,30.040;104.061,30.040",
                  "vehicle_info": {"detail": None}}],
            ],
        }]}}
        driving = {
            "status": 0,
            "result": {"routes": [{
                "distance": 6000, "duration": 700,
                "steps": [{"path": "104.001,30.000;104.030,30.020;104.060,30.040"}],
            }]},
        }
        with mock.patch("serve._baidu_request", return_value=(driving, None)) as req:
            out = serve.smooth_transit_path(data, "ak")
        self.assertIsNotNone(out)
        self.assertIn([104.030, 30.020], out)
        self.assertEqual(req.call_count, 1)


class TestRailStations(unittest.TestCase):
    RAW = ("var station_names ='@bjb|北京北|VAP|beijingbei|bjb|0|0357|北京|||"
           "@cdd|成都东|ICW|chengdudong|cdd|36|1707|成都|||"
           "@cdx|成都西|CDW|chengduxi|cdx|37|1707|成都|||'")

    def test_parse_and_filter_by_city_and_pinyin(self):
        stations = serve.parse_12306_stations(self.RAW)
        self.assertEqual(len(stations), 3)
        self.assertEqual(stations[1]["city"], "成都")
        out = serve.filter_rail_stations(stations, "成都", "东")
        self.assertEqual([s["name"] for s in out], ["成都东"])
        out = serve.filter_rail_stations(stations, "成都", "chengduxi")
        self.assertEqual([s["name"] for s in out], ["成都西"])

    def test_city_list_keeps_only_that_city(self):
        stations = serve.parse_12306_stations(self.RAW)
        out = serve.filter_rail_stations(stations, "北京")
        self.assertEqual([s["name"] for s in out], ["北京北"])


class TestFreeCoordinates(unittest.TestCase):
    def test_wgs84_to_gcj02_shifts_inside_china(self):
        lng, lat = serve.wgs84_to_gcj02(116.3974, 39.9093)
        self.assertAlmostEqual(lng, 116.4036, delta=0.002)
        self.assertAlmostEqual(lat, 39.9108, delta=0.002)

    def test_coordinates_outside_china_unchanged(self):
        self.assertEqual(serve.wgs84_to_gcj02(-0.1276, 51.5072), [-0.1276, 51.5072])


class TestParseNominatim(unittest.TestCase):
    def test_extracts_names_tags_and_gcj02_coords(self):
        data = [
            {"lat": "39.9093", "lon": "116.3974", "class": "tourism",
             "type": "attraction", "address": {"name": "故宫博物院"},
             "display_name": "故宫博物院, 东城区, 北京市, 中国"},
            {"lat": "39.9612", "lon": "116.4696", "class": "aeroway",
             "type": "aerodrome", "address": {"name": "北京首都国际机场"},
             "display_name": "北京首都国际机场, 顺义区, 北京市, 中国"},
            {"lat": "31.2304", "lon": "121.4737", "class": "railway",
             "type": "station", "address": {"name": "上海站"},
             "display_name": "上海站, 静安区, 上海市, 中国"},
            {"lat": "31.2404", "lon": "121.4837", "class": "tourism",
             "type": "hotel", "address": {"name": "测试酒店"},
             "display_name": "测试酒店, 上海市, 中国"},
        ]
        out = serve.parse_nominatim_places(data, limit=8)
        self.assertEqual([p["name"] for p in out], ["故宫博物院", "北京首都国际机场", "上海站", "测试酒店"])
        self.assertEqual([p["tag"] for p in out], ["景点", "机场", "车站", "酒店"])
        self.assertTrue(all(p["source"] == "OpenStreetMap" for p in out))
        self.assertNotEqual(out[0]["lng"], 116.3974)  # 已转 GCJ-02

    def test_dedupes_skips_invalid_and_respects_limit(self):
        data = [
            {"lat": "30.0", "lon": "104.0", "address": {"name": "重复"}},
            {"lat": "30.1", "lon": "104.1", "address": {"name": "重复"}},
            {"lat": "bad", "lon": "104.2", "address": {"name": "坏坐标"}},
            {"lat": "30.2", "lon": "104.3", "address": {}},
            {"lat": "30.3", "lon": "104.4", "address": {"name": "第二个"}},
            {"lat": "30.4", "lon": "104.5", "address": {"name": "第三个"}},
            "not-a-dict",
        ]
        out = serve.parse_nominatim_places(data, limit=2)
        self.assertEqual([p["name"] for p in out], ["重复", "第二个"])


class TestParseOverpass(unittest.TestCase):
    def test_prefers_chinese_name_and_skips_unnamed(self):
        data = {"elements": [
            {"type": "node", "id": 1, "lat": 30.0, "lon": 104.0,
             "tags": {"name": "Old Name", "name:zh": "中文名", "tourism": "museum"}},
            {"type": "way", "id": 2,
             "center": {"lat": 30.1, "lon": 104.1},
             "tags": {"name": "无中文", "historic": "memorial"}},
            {"type": "node", "id": 3, "lat": 30.2, "lon": 104.2, "tags": {}},
            {"type": "node", "id": 4, "lat": None, "lon": None, "tags": {"name": "坏坐标"}},
        ]}
        out = serve.parse_overpass_places(data, limit=10)
        self.assertEqual([p["name"] for p in out], ["中文名", "无中文"])
        self.assertEqual(out[0]["id"], "osm-node-1")
        self.assertEqual(out[1]["id"], "osm-way-2")
        self.assertEqual(out[0]["tier"], "explore")
        self.assertEqual(out[0]["note"], "OpenStreetMap · museum")
        self.assertNotEqual(out[0]["lng"], 104.0)

    def test_sorts_by_distance_from_center(self):
        data = {"elements": [
            {"type": "node", "id": 1, "lat": 30.30, "lon": 104.30, "tags": {"name": "远"}},
            {"type": "node", "id": 2, "lat": 30.01, "lon": 104.01, "tags": {"name": "近"}},
            {"type": "node", "id": 3, "lat": 30.10, "lon": 104.10, "tags": {"name": "中"}},
        ]}
        out = serve.parse_overpass_places(data, limit=2, center=[104.0, 30.0])
        self.assertEqual([p["name"] for p in out], ["近", "中"])

    def test_query_contains_radius_and_tags(self):
        q = serve.build_overpass_attractions_query(30.0, 104.0, radius=12000)
        self.assertIn("around:12000,30.000000,104.000000", q)
        self.assertIn("tourism", q)
        self.assertIn("historic", q)


class TestFreeHandlers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old = (serve.CACHE_ENABLED, serve.CACHE_DIR, serve.CACHE_FILE, serve._CACHE)
        serve.CACHE_ENABLED = True
        serve.CACHE_DIR = Path(self.tmp.name)
        serve.CACHE_FILE = Path(self.tmp.name) / "cache.json"
        serve._CACHE = None

    def tearDown(self):
        # Windows 下 sqlite 连接不关掉会锁住临时目录，先关再删
        if serve._CACHE is not None:
            try:
                serve._CACHE.close()
            except Exception:
                pass
        serve.CACHE_ENABLED, serve.CACHE_DIR, serve.CACHE_FILE, serve._CACHE = self.old
        self.tmp.cleanup()

    NOMINATIM = [{
        "lat": "30.6729", "lon": "104.0665", "class": "tourism",
        "type": "attraction", "address": {"name": "宽窄巷子"},
        "display_name": "宽窄巷子, 青羊区, 成都市, 四川省, 中国",
    }]

    OVERPASS = {"elements": [
        {"type": "node", "id": 9, "lat": 30.68, "lon": 104.07,
         "tags": {"name": "人民公园", "tourism": "attraction"}},
    ]}

    def test_places_handler_caches_result(self):
        with mock.patch("serve._free_get_json", return_value=self.NOMINATIM) as get:
            first = serve.handle_free_places("q=宽窄巷子&city=成都")
            second = serve.handle_free_places("q=宽窄巷子&city=成都")
        self.assertTrue(first["ok"])
        self.assertEqual(first["places"][0]["name"], "宽窄巷子")
        self.assertFalse(first.get("cached", False))
        self.assertTrue(second["cached"])
        self.assertEqual(get.call_count, 1)

    def test_places_handler_requires_query(self):
        out = serve.handle_free_places("city=成都")
        self.assertFalse(out["ok"])
        self.assertIn("q", out["error"])

    def test_places_handler_reports_upstream_failure(self):
        with mock.patch("serve._free_get_json", side_effect=urllib.error.URLError("down")):
            out = serve.handle_free_places("q=宽窄巷子")
        self.assertFalse(out["ok"])
        self.assertEqual(out["places"], [])

    def test_attractions_handler_caches_and_sorts(self):
        with mock.patch("serve._free_get_json", return_value=self.OVERPASS) as get:
            first = serve.handle_free_attractions("lat=30.66&lng=104.06&limit=30")
            second = serve.handle_free_attractions("lat=30.66&lng=104.06&limit=30")
        self.assertTrue(first["ok"])
        self.assertEqual(first["places"][0]["name"], "人民公园")
        self.assertTrue(second["cached"])
        self.assertEqual(get.call_count, 1)

    def test_attractions_handler_falls_back_to_mirror(self):
        with mock.patch("serve._free_get_json",
                        side_effect=[urllib.error.URLError("down"), self.OVERPASS]) as get:
            out = serve.handle_free_attractions("lat=30.66&lng=104.06")
        self.assertTrue(out["ok"])
        self.assertEqual(get.call_count, 2)
        self.assertIn("kumi.systems", get.call_args_list[1][0][0])

    def test_attractions_handler_validates_coords(self):
        out = serve.handle_free_attractions("lat=abc&lng=104.06")
        self.assertFalse(out["ok"])
        self.assertIn("lat", out["error"])


class TestSqliteCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old = (serve.CACHE_ENABLED, serve.CACHE_DIR, serve.CACHE_FILE,
                    serve._CACHE, serve._DB, serve._DB_PATH)
        serve.CACHE_ENABLED = True
        serve.CACHE_DIR = Path(self.tmp.name)
        serve.CACHE_FILE = Path(self.tmp.name) / "baidu.json"
        serve._CACHE = None
        serve._DB = None
        serve._DB_PATH = None

    def tearDown(self):
        if serve._DB is not None:
            try:
                serve._DB.close()
            except Exception:
                pass
        (serve.CACHE_ENABLED, serve.CACHE_DIR, serve.CACHE_FILE,
         serve._CACHE, serve._DB, serve._DB_PATH) = self.old
        self.tmp.cleanup()

    def test_survives_reconnect(self):
        serve.cache_set("places", "k1", {"name": "宽窄巷子", "lng": 104.0})
        # 模拟进程重启：关闭连接后重新打开同一个数据库文件
        serve._DB.close()
        serve._DB = None
        serve._DB_PATH = None
        serve._CACHE = None
        self.assertEqual(serve.cache_get("places", "k1", None)["name"], "宽窄巷子")
        self.assertTrue(serve._cache_db_path().exists())

    def test_no_ttl_means_never_expires(self):
        serve.cache_set("routes", "old", {"km": 3.2})
        serve._DB.execute("UPDATE cache SET created=0 WHERE key='old'")
        serve._DB.commit()
        self.assertEqual(serve.cache_get("routes", "old", None)["km"], 3.2)
        # 显式传 TTL 时仍可按时间过期（免费数据源仍用 7/30 天）
        self.assertIsNone(serve.cache_get("routes", "old", 1.0))

    def test_hit_count_increments(self):
        serve.cache_set("places", "k", [1])
        for _ in range(3):
            serve.cache_get("places", "k")
        hits = serve._DB.execute(
            "SELECT hits FROM cache WHERE section='places' AND key='k'").fetchone()[0]
        self.assertEqual(hits, 3)

    def test_evicts_lowest_frequency_first(self):
        serve.cache_set("places", "hot", {"v": "h" * 100})
        serve.cache_set("places", "cold", {"v": "c" * 100})
        for _ in range(10):
            serve.cache_get("places", "hot")
        # 每个 value 的 JSON 约 100+ 字节；上限 3KB、目标 2.7KB
        with mock.patch("serve.cache_max_bytes", return_value=3000):
            serve.cache_set("places", "big", {"v": "x" * 5000})
        left = {row[0] for row in serve._DB.execute("SELECT key FROM cache")}
        self.assertIn("hot", left)
        self.assertNotIn("cold", left)
        self.assertNotIn("big", left)

    def test_config_default_and_update(self):
        self.assertEqual(serve.handle_cache_config()["maxMb"], 500)
        out = serve.handle_cache_config({"maxMb": 120})
        self.assertTrue(out["ok"])
        self.assertEqual(out["maxMb"], 120)
        self.assertEqual(serve.cache_max_mb(), 120)
        # 重新打开数据库后设置仍在
        serve._DB.close()
        serve._DB = None
        serve._DB_PATH = None
        serve._CACHE = None
        self.assertEqual(serve.handle_cache_config()["maxMb"], 120)

    def test_config_rejects_bad_values(self):
        self.assertFalse(serve.handle_cache_config({"maxMb": "abc"})["ok"])
        self.assertFalse(serve.handle_cache_config({"maxMb": 1})["ok"])
        self.assertFalse(serve.handle_cache_config({})["ok"])

    def test_env_default_used_when_unset(self):
        with mock.patch.dict(os.environ, {"BAIDU_CACHE_MAX_MB": "250"}):
            self.assertEqual(serve.cache_max_mb(), 250)

    def test_migrates_legacy_json_cache(self):
        legacy = {
            "places": {"p1": {"t": 1700000000, "v": [{"name": "旧地点"}]}},
            "routes": {"r1": {"t": 1700000000, "v": {"km": 1.5}}},
        }
        serve.CACHE_FILE.write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
        self.assertEqual(serve.cache_get("places", "p1")[0]["name"], "旧地点")
        self.assertEqual(serve.cache_get("routes", "r1")["km"], 1.5)
        self.assertFalse(serve.CACHE_FILE.exists())
        self.assertTrue(serve.CACHE_FILE.with_suffix(".json.migrated").exists())
        # 迁移只执行一次，不会重复导入
        serve._DB.close()
        serve._DB = None
        serve._DB_PATH = None
        serve._CACHE = None
        self.assertTrue(serve.cache_get("places", "p1"))
        self.assertEqual(serve.cache_stats()["entries"], 2)

    def test_stats_reports_size_and_sections(self):
        serve.cache_set("places", "a", [{"x": 1}])
        serve.cache_set("routes", "b", {"km": 2})
        stats = serve.cache_stats()
        self.assertEqual(stats["entries"], 2)
        self.assertEqual(stats["sections"], {"places": 1, "routes": 1})
        self.assertEqual(stats["maxMb"], 500)
        self.assertGreater(stats["sizeBytes"], 0)


if __name__ == "__main__":
    unittest.main()
