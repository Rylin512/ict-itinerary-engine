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


if __name__ == "__main__":
    unittest.main()
