"""serve.py 联网搜索代理的回归测试：请求构造 / 响应解析 / key 解析。

    python -m unittest discover -s tests -t . -v
"""

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import serve  # noqa: E402


class TestSearchRequest(unittest.TestCase):
    def test_bocha_request_shape(self):
        url, headers, payload = serve.build_search_request("bocha", "bk-1", "成都 美食", 6)
        self.assertEqual(url, "https://api.bochaai.com/v1/web-search")
        self.assertEqual(headers["Authorization"], "Bearer bk-1")
        self.assertEqual(payload["query"], "成都 美食")
        self.assertEqual(payload["count"], 6)
        self.assertTrue(payload["summary"])

    def test_tavily_request_shape(self):
        url, headers, payload = serve.build_search_request("tavily", "tvly-1", "成都 美食", 4)
        self.assertEqual(url, "https://api.tavily.com/search")
        self.assertEqual(headers["Authorization"], "Bearer tvly-1")
        self.assertEqual(payload["max_results"], 4)

    def test_rejects_empty_query_and_unknown_provider(self):
        with self.assertRaises(ValueError):
            serve.build_search_request("bocha", "k", "  ", 6)
        with self.assertRaises(ValueError):
            serve.build_search_request("google", "k", "q", 6)


class TestSearchParse(unittest.TestCase):
    def test_parse_bocha(self):
        data = {"code": 200, "data": {"webPages": {"value": [
            {"name": "成都美食攻略", "url": "https://x.example/a", "snippet": "s1", "summary": "sum1"},
            {"url": "https://x.example/b"},           # 缺 title
            "not-a-dict",                              # 脏数据跳过
        ]}}}
        out = serve.parse_search_response("bocha", data)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["title"], "成都美食攻略")
        self.assertEqual(out[0]["snippet"], "sum1")     # summary 优先于 snippet
        self.assertEqual(out[1]["title"], "")

    def test_parse_tavily(self):
        data = {"results": [{"title": "t", "url": "https://x.example/c", "content": "c1"}]}
        out = serve.parse_search_response("tavily", data)
        self.assertEqual(out, [{"title": "t", "url": "https://x.example/c", "snippet": "c1"}])

    def test_parse_tolerates_missing_fields(self):
        self.assertEqual(serve.parse_search_response("bocha", {}), [])
        self.assertEqual(serve.parse_search_response("tavily", {}), [])


class TestHandleWebSearch(unittest.TestCase):
    def setUp(self):
        # 这些用例断言"是否打到上游"，必须绕开磁盘缓存（缓存命中会让 call_upstream 不触发）
        self._cache_enabled = serve.CACHE_ENABLED
        serve.CACHE_ENABLED = False

    def tearDown(self):
        serve.CACHE_ENABLED = self._cache_enabled

    def _reply(self, payload):
        resp = mock.MagicMock()
        resp.read.return_value = json.dumps(payload).encode("utf-8")
        resp.__enter__.return_value = resp
        return resp

    def test_auto_provider_uses_env_key(self):
        env = {"BOCHA_API_KEY": "bk-env"}
        data = {"data": {"webPages": {"value": [{"name": "n", "url": "https://x.example/d"}]}}}
        with mock.patch.dict(os.environ, env), \
             mock.patch("serve.call_upstream", return_value=data) as cu:
            out = serve.handle_web_search({"query": "成都"}, {})
        self.assertTrue(out["ok"])
        self.assertEqual(out["provider"], "bocha")
        self.assertEqual(out["results"][0]["title"], "n")
        self.assertEqual(cu.call_args[0][0], "https://api.bochaai.com/v1/web-search")

    def test_header_key_wins_over_env(self):
        with mock.patch.dict(os.environ, {"BOCHA_API_KEY": "bk-env"}), \
             mock.patch("serve.call_upstream", return_value={}) as cu:
            serve.handle_web_search({"query": "成都"}, {"X-Search-Key": "bk-header"})
        self.assertEqual(cu.call_args[0][1]["Authorization"], "Bearer bk-header")

    def test_missing_key_and_empty_query(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            out = serve.handle_web_search({"query": "成都", "provider": "bocha"}, {})
        self.assertFalse(out["ok"])
        self.assertIn("key", out["error"])
        out = serve.handle_web_search({"query": "  "}, {"X-Search-Key": "k"})
        self.assertFalse(out["ok"])
        self.assertIn("query", out["error"])

    def test_auto_without_any_key_reports_config_hint(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            out = serve.handle_web_search({"query": "成都"}, {})
        self.assertFalse(out["ok"])
        self.assertIn("BOCHA_API_KEY", out["error"])

    def test_count_is_clamped(self):
        with mock.patch.dict(os.environ, {"BOCHA_API_KEY": "bk"}), \
             mock.patch("serve.call_upstream", return_value={}) as cu:
            serve.handle_web_search({"query": "q", "count": 99}, {})
        self.assertEqual(cu.call_args[0][2]["count"], 10)


class TestAiConfigSearch(unittest.TestCase):
    def test_search_readiness_reported(self):
        with mock.patch.dict(os.environ, {"BOCHA_API_KEY": "bk"}):
            cfg = serve.ai_config()
        self.assertTrue(cfg["search"]["bocha"])
        self.assertFalse(cfg["search"]["tavily"])
        self.assertTrue(cfg["search"]["demo"])  # 离线演示源恒可用


class TestDemoSearch(unittest.TestCase):
    def test_demo_provider_needs_no_key_and_mentions_query(self):
        out = serve.handle_web_search({"query": "成都 美食", "provider": "demo", "count": 3}, {})
        self.assertTrue(out["ok"])
        self.assertEqual(out["provider"], "demo")
        self.assertEqual(len(out["results"]), 3)
        self.assertTrue(all("演示" in r["title"] for r in out["results"]))
        self.assertTrue(all(r["url"] for r in out["results"]))

    def test_demo_count_clamped_to_canned_size(self):
        out = serve.handle_web_search({"query": "q", "provider": "demo", "count": 10}, {})
        self.assertEqual(len(out["results"]), 3)


class TestDeepSeekSearch(unittest.TestCase):
    def setUp(self):
        self._cache_enabled = serve.CACHE_ENABLED
        serve.CACHE_ENABLED = False

    def tearDown(self):
        serve.CACHE_ENABLED = self._cache_enabled

    def test_request_shape(self):
        url, headers, payload = serve.build_search_request("deepseek", "sk-1", "成都 三日游", 5)
        self.assertEqual(url, "https://api.deepseek.com/v1/tools/search")
        self.assertEqual(headers["Authorization"], "Bearer sk-1")
        self.assertEqual(payload["query"], "成都 三日游")
        self.assertEqual(payload["count"], 5)
        self.assertFalse(payload["need_content"])

    def test_parse_prefers_summary(self):
        data = {"results": [
            {"title": "成都攻略", "url": "https://x.example/a",
             "summary": "长摘要", "snippet": "短摘要"},
            {"title": "缺摘要", "url": "https://x.example/b", "snippet": "只有短摘要"},
            {"url": ""},                                # 无 url 跳过
        ]}
        out = serve.parse_search_response("deepseek", data)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["snippet"], "长摘要")
        self.assertEqual(out[1]["snippet"], "只有短摘要")

    def test_handler_uses_deepseek_key_and_endpoint(self):
        data = {"results": [{"title": "t", "url": "https://x.example/c", "summary": "s"}]}

        class _Resp:
            def __init__(self, payload):
                self._raw = json.dumps(payload).encode("utf-8")

            def read(self):
                return self._raw

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-env"}, clear=True), \
             mock.patch("serve.urllib.request.urlopen", return_value=_Resp(data)) as up:
            out = serve.handle_web_search({"query": "成都 美食", "provider": "deepseek"}, {})
        self.assertTrue(out["ok"])
        self.assertEqual(out["provider"], "deepseek")
        self.assertEqual(out["results"][0]["url"], "https://x.example/c")
        req = up.call_args[0][0]
        self.assertEqual(req.full_url, "https://api.deepseek.com/v1/tools/search")
        self.assertEqual(req.get_header("Authorization"), "Bearer sk-env")

    def test_auto_falls_back_to_deepseek_when_only_that_key_exists(self):
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-env"}, clear=True), \
             mock.patch("serve.call_upstream", return_value={"results": []}) as cu:
            out = serve.handle_web_search({"query": "成都"}, {})
        self.assertTrue(out["ok"])
        self.assertEqual(out["provider"], "deepseek")
        self.assertEqual(cu.call_args[0][0], "https://api.deepseek.com/v1/tools/search")

    def test_ai_config_reports_deepseek(self):
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk"}, clear=True):
            self.assertTrue(serve.ai_config()["search"]["deepseek"])


class TestSearchCache(unittest.TestCase):
    def setUp(self):
        import tempfile
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

    def test_same_query_hits_cache(self):
        data = {"results": [{"title": "t", "url": "https://x.example/d", "summary": "s"}]}
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk"}, clear=True), \
             mock.patch("serve.call_upstream", return_value=data) as cu:
            first = serve.handle_web_search({"query": "成都 美食", "provider": "deepseek"}, {})
            second = serve.handle_web_search({"query": " 成都 美食 ", "provider": "deepseek"}, {})
        self.assertTrue(first["ok"])
        self.assertEqual(cu.call_count, 1)
        self.assertTrue(second.get("cached"))


if __name__ == "__main__":
    unittest.main()
