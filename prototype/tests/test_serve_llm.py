"""serve.py LLM 代理的回归测试：key 解析 / 白名单 / 上游请求构造。

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

    def test_call_upstream_timeout_is_capped(self):
        # 前端 AI.chat 60s 就中断请求；上游等待必须 ≤ 前端超时，
        # 否则浏览器已放弃、页面永远停在"生成中"（AI 使用卡住的根因之一）。
        captured = {}
        resp = mock.MagicMock()
        resp.read.return_value = b'{"ok":true}'
        resp.__enter__.return_value = resp
        with mock.patch("serve.urllib.request.urlopen",
                        side_effect=lambda req, timeout: captured.update(t=timeout) or resp):
            serve.call_upstream("https://api.deepseek.com/v1/chat/completions", {}, {})
        self.assertLessEqual(captured["t"], 60)


class TestLlmModels(unittest.TestCase):
    """模型列表接口：channel 模型名经常下线，前端靠它自查可用模型。"""

    def _headers(self, key="sk-test"):
        return {"X-Api-Key": key}

    def _mock_reply(self, payload, status=None):
        resp = mock.MagicMock()
        resp.read.return_value = json.dumps(payload).encode("utf-8")
        resp.__enter__.return_value = resp
        return resp

    def test_returns_model_ids(self):
        reply = self._mock_reply({"data": [{"id": "deepseek-chat"}, {"id": "deepseek-reasoner"}, {"x": 1}]})
        with mock.patch("serve.urllib.request.urlopen", return_value=reply):
            out = serve.handle_llm_models({"baseURL": "https://api.deepseek.com/v1"}, self._headers())
        self.assertTrue(out["ok"])
        self.assertEqual(out["models"], ["deepseek-chat", "deepseek-reasoner"])

    def test_rejects_bad_host_and_missing_key(self):
        out = serve.handle_llm_models({"baseURL": "https://evil.com/v1"}, self._headers())
        self.assertFalse(out["ok"])
        self.assertIn("白名单", out["error"])
        with mock.patch.dict(os.environ, {}, clear=True):
            out = serve.handle_llm_models({"baseURL": "https://api.deepseek.com/v1"}, {})
        self.assertFalse(out["ok"])
        self.assertIn("key", out["error"])

    def test_http_error_is_reported(self):
        err = serve.urllib.error.HTTPError(
            "https://api.deepseek.com/v1/models", 401, "Unauthorized", {},
            mock.MagicMock(read=lambda: b'{"error":"invalid key"}'),
        )
        with mock.patch("serve.urllib.request.urlopen", side_effect=err):
            out = serve.handle_llm_models({"baseURL": "https://api.deepseek.com/v1"}, self._headers())
        self.assertFalse(out["ok"])
        self.assertIn("401", out["error"])
        self.assertIn("invalid key", out["error"])


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
