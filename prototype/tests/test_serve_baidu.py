"""serve.py 百度路线代理的回归测试：AK 解析 / URL 构造 / 响应解析。

    python -m unittest discover -s tests -t . -v
"""

import os
import sys
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
        url = serve.build_baidu_driving_url("ak-1", [104.067, 30.572], [104.141, 30.630])
        self.assertIn("https://api.map.baidu.com/direction/v2/driving?", url)
        self.assertIn("origin=104.067000,30.572000", url)
        self.assertIn("destination=104.141000,30.630000", url)
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
