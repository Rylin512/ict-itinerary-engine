"""serve.py LLM 代理的回归测试：key 解析 / 白名单 / 上游请求构造。

    python -m unittest discover -s tests -t . -v
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import serve  # noqa: E402


class TestLlmAllowedHost(unittest.TestCase):
    def test_allowlist(self):
        self.assertTrue(serve.llm_allowed_host("https://api.deepseek.com/v1"))
        self.assertTrue(serve.llm_allowed_host("https://openrouter.ai/api/v1"))
        self.assertTrue(serve.llm_allowed_host("https://api.siliconflow.cn/v1"))
        self.assertTrue(serve.llm_allowed_host("https://api.modelarts-maas.com/v1"))

    def test_rejects_non_https_and_unknown(self):
        self.assertFalse(serve.llm_allowed_host("http://api.deepseek.com/v1"))
        self.assertFalse(serve.llm_allowed_host("https://evil.example.com/v1"))
        self.assertFalse(serve.llm_allowed_host("file:///etc/passwd"))
        self.assertFalse(serve.llm_allowed_host(""))

    def test_env_extra_hosts(self):
        with mock.patch.dict(os.environ, {"LLM_ALLOWED_HOSTS": "my-gateway.example.com"}):
            self.assertTrue(serve.llm_allowed_host("https://my-gateway.example.com/v1"))
            self.assertFalse(serve.llm_allowed_host("https://sub.my-gateway.other.com/v1"))


class TestResolveKey(unittest.TestCase):
    def test_header_wins(self):
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "env-key"}):
            self.assertEqual(
                serve.resolve_llm_key("https://api.deepseek.com/v1", "header-key"),
                "header-key",
            )

    def test_env_by_host(self):
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-1"}):
            self.assertEqual(serve.resolve_llm_key("https://api.deepseek.com/v1"), "sk-1")
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "or-1"}):
            self.assertEqual(serve.resolve_llm_key("https://openrouter.ai/api/v1"), "or-1")

    def test_generic_fallback_and_missing(self):
        with mock.patch.dict(os.environ, {"LLM_API_KEY": "generic"}):
            self.assertEqual(serve.resolve_llm_key("https://api.openai.com/v1"), "generic")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(serve.resolve_llm_key("https://api.deepseek.com/v1"))


class TestBuildRequest(unittest.TestCase):
    def _body(self, **kw):
        base = {
            "baseURL": "https://api.deepseek.com/v1",
            "model": "deepseek-chat",
            "messages": [{"role": "user", "content": "hi"}],
        }
        base.update(kw)
        return base

    def test_builds_auth_header_and_payload(self):
        url, headers, payload = serve.build_upstream_request(self._body(), "sk-test")
        self.assertEqual(url, "https://api.deepseek.com/v1/chat/completions")
        self.assertEqual(headers["Authorization"], "Bearer sk-test")
        self.assertEqual(payload["model"], "deepseek-chat")
        self.assertFalse(payload["stream"])
        self.assertNotIn("temperature", payload)

    def test_openrouter_extra_headers_and_options(self):
        body = self._body(baseURL="https://openrouter.ai/api/v1",
                          temperature=0.3, max_tokens=500)
        url, headers, payload = serve.build_upstream_request(body, "or-test")
        self.assertEqual(headers["HTTP-Referer"], "http://127.0.0.1:8765")
        self.assertEqual(payload["temperature"], 0.3)
        self.assertEqual(payload["max_tokens"], 500)

    def test_missing_fields_and_bad_host_and_no_key(self):
        with self.assertRaises(ValueError):
            serve.build_upstream_request({"baseURL": "", "model": "m", "messages": [1]}, "k")
        with self.assertRaises(ValueError):
            serve.build_upstream_request(self._body(baseURL="https://evil.com/v1"), "k")
        with self.assertRaises(ValueError):
            serve.build_upstream_request(self._body(), None)


class TestAiConfig(unittest.TestCase):
    def test_channels_report_readiness_only(self):
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-secret-123"}):
            cfg = serve.ai_config()
        self.assertTrue(cfg["proxy"])
        deep = [c for c in cfg["channels"] if c["env"] == "DEEPSEEK_API_KEY"][0]
        self.assertTrue(deep["ready"])
        orr = [c for c in cfg["channels"] if c["env"] == "OPENROUTER_API_KEY"][0]
        self.assertFalse(orr["ready"])
        self.assertNotIn("sk-secret-123", str(cfg))  # key 内容绝不回传


if __name__ == "__main__":
    unittest.main()
