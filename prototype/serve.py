"""最小 HTTP 服务：跨城规划页静态托管 + LLM / 百度地图代理。

只用标准库（http.server），队友只要有 Python 就能跑，不用装任何东西。
（单城编排引擎保留在 engine/，通过命令行 run_demo.py 演示，不再提供 Web 接口。）

    python serve.py                 # http://127.0.0.1:8765 （根路径重定向到 /travel.html）
    python serve.py --host 0.0.0.0  # 手机同一 WiFi 下访问 http://<你的IP>:8765

接口：
    GET  /api/ai-config      本地可用的 LLM 渠道探测（key 只报有无，不回传内容）
    POST /api/llm            OpenAI 兼容 LLM 代理（解决浏览器 CORS 与 key 不落盘）
    GET  /api/baidu-config   百度服务器端 AK 探测
    POST /api/baidu/driving  百度路线规划代理（浏览器跨域 / AK 不落盘）

LLM key 环境变量：DEEPSEEK_API_KEY / OPENROUTER_API_KEY / SILICONFLOW_API_KEY /
HUAWEI_MAAS_API_KEY / LLM_API_KEY（通用兜底）；请求头 X-Api-Key 优先于环境变量。
百度地图 AK：环境变量 BAIDU_MAP_AK 或请求头 X-Baidu-Ak，用于 /api/baidu/driving
代理百度 Web 服务路线规划（浏览器跨域 / AK 不落盘）。
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"


# ================= LLM 代理（DeepSeek / OpenRouter / SiliconFlow / 华为云 MaaS） =================
# 浏览器直连 api.deepseek.com 会被 CORS 拦截，key 也会暴露在前端代码里；
# 本地 serve.py 做一层转发：key 从请求头或环境变量取，页面里永远不落盘。

LLM_HOST_KEYS = [  # host 关键字 -> 环境变量名（按顺序匹配）
    ("openrouter.ai", "OPENROUTER_API_KEY"),
    ("api.deepseek.com", "DEEPSEEK_API_KEY"),
    ("api.siliconflow.cn", "SILICONFLOW_API_KEY"),
    ("modelarts-maas.com", "HUAWEI_MAAS_API_KEY"),
]


def llm_allowed_host(url):
    """只允许 https + 白名单上游（可用环境变量 LLM_ALLOWED_HOSTS 追加）。"""
    try:
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    if not url.lower().startswith("https://") or not host:
        return False
    extra = [h.strip().lower() for h in os.environ.get("LLM_ALLOWED_HOSTS", "").split(",") if h.strip()]
    allowed = ["api.deepseek.com", "openrouter.ai", "api.siliconflow.cn",
               "api.modelarts-maas.com", "api.openai.com"] + extra
    return any(host == h or host.endswith("." + h) for h in allowed)


def resolve_llm_key(base_url, header_key=None):
    """key 优先级：请求头 X-Api-Key > 按上游域名匹配的环境变量 > 通用 LLM_API_KEY。"""
    if header_key:
        return header_key
    host = base_url.lower()
    for frag, env in LLM_HOST_KEYS:
        if frag in host and os.environ.get(env):
            return os.environ[env]
    return os.environ.get("LLM_API_KEY")


def build_upstream_request(body, key):
    """把前端请求整理成对上游的 (url, headers, payload)，全是纯函数便于单测。"""
    base_url = (body.get("baseURL") or "").rstrip("/")
    model = body.get("model") or ""
    messages = body.get("messages") or []
    if not base_url or not model or not messages:
        raise ValueError("baseURL / model / messages 必填")
    if not llm_allowed_host(base_url):
        raise ValueError(f"上游 {base_url} 不在白名单内，可用环境变量 LLM_ALLOWED_HOSTS 追加")
    if not key:
        raise ValueError("未找到 API key：请在前端填写，或为 serve.py 设置对应环境变量")
    url = base_url + "/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
    }
    if "openrouter" in base_url.lower():
        headers["HTTP-Referer"] = "http://127.0.0.1:8765"
        headers["X-Title"] = "ict-itinerary-engine"
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
    }
    if body.get("temperature") is not None:
        payload["temperature"] = float(body["temperature"])
    if body.get("max_tokens"):
        payload["max_tokens"] = int(body["max_tokens"])
    return url, headers, payload


def ai_config():
    """告诉前端本地有哪些现成渠道（key 只报有没有，不报内容）。"""
    return {
        "proxy": True,
        "channels": [
            {"id": frag, "env": env, "ready": bool(os.environ.get(env))}
            for frag, env in LLM_HOST_KEYS
        ],
        "fallbackReady": bool(os.environ.get("LLM_API_KEY")),
    }


def call_upstream(url, headers, payload, timeout=120):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def handle_llm(body, headers_in):
    try:
        key = resolve_llm_key(body.get("baseURL") or "", headers_in.get("X-Api-Key"))
        url, headers, payload = build_upstream_request(body, key)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    try:
        data = call_upstream(url, headers, payload)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        return {"ok": False, "error": f"上游返回 {exc.code}：{detail}"}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"ok": False, "error": f"上游连接失败：{exc}"}
    content = ""
    try:
        content = data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return {"ok": False, "error": f"上游响应格式异常：{json.dumps(data, ensure_ascii=False)[:300]}"}
    return {"ok": True, "content": content, "usage": data.get("usage", {})}


# ================= 百度地图开放平台代理（驾车路线规划 direction/v2） =================
# 浏览器直连 Web 服务 API 会被 CORS 拦且 AK 暴露；本地 serve.py 转发。
# AK 优先级：请求头 X-Baidu-Ak > 环境变量 BAIDU_MAP_AK。

BAIDU_DRIVING_URL = "https://api.map.baidu.com/direction/v2/driving"

# 个人认证 AK 的路线规划限 2 次/秒：代理层全局节流，相邻上游调用间隔 ≥0.55s。
# 多个前端并发请求在闸门前排队，保证任何时刻都不会超限。
BAIDU_MIN_INTERVAL = 0.55
_BAIDU_GATE_LOCK = threading.Lock()
_BAIDU_LAST_CALL = [0.0]


def baidu_gate():
    with _BAIDU_GATE_LOCK:
        wait = _BAIDU_LAST_CALL[0] + BAIDU_MIN_INTERVAL - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _BAIDU_LAST_CALL[0] = time.monotonic()


def resolve_baidu_ak(header_key=None):
    return header_key or os.environ.get("BAIDU_MAP_AK")


def baidu_ready():
    return bool(os.environ.get("BAIDU_MAP_AK"))


def baidu_browser_ak():
    """浏览器端 AK（JS API GL）只从环境变量读取。

    浏览器端 AK 按设计就是下发给页面的凭据，靠 Referer 白名单保护；
    这里只在显式配置时下发，没配就返回空串，页面自动回退 OSM 底图。
    """
    return os.environ.get("BAIDU_BROWSER_AK", "")


def baidu_config():
    return {
        "ready": baidu_ready(),
        "host": "api.map.baidu.com",
        "browserAK": baidu_browser_ak(),
        "minInterval": int(BAIDU_MIN_INTERVAL * 1000),
    }


def _coord(v):
    """校验单个坐标值并格式化为百度要求的 6 位小数。"""
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"坐标非法：{v!r}")
    if not (-180 <= x <= 180):
        raise ValueError(f"坐标越界：{x}")
    return f"{x:.6f}"


def build_baidu_driving_url(ak, from_pair, to_pair):
    """from/to 为 [lng, lat]（GCJ-02，页面数据坐标系，与高德/OSRM 一致）。
    百度 direction API 要求 origin/destination 为「纬度,经度」，这里做一次换序。纯函数便于单测。"""
    if not ak:
        raise ValueError("未找到百度 AK：请在设置面板填写，或为 serve.py 设置环境变量 BAIDU_MAP_AK")
    if len(from_pair) != 2 or len(to_pair) != 2:
        raise ValueError("from / to 需为 [经度, 纬度] 二元组")
    o = f"{_coord(from_pair[1])},{_coord(from_pair[0])}"  # 百度要 lat,lng
    d = f"{_coord(to_pair[1])},{_coord(to_pair[0])}"
    return (f"{BAIDU_DRIVING_URL}?origin={o}&destination={d}"
            f"&coord_type=gcj02&ret_coordtype=bd09ll&ak={ak}")


def parse_baidu_driving(data):
    """从 direction/v2 响应提取 (km, min)。status!=0 时抛 ValueError 带官方 message。"""
    status = data.get("status")
    if status != 0:
        raise ValueError(f"百度返回 status={status}：{data.get('message', '未知错误')}")
    routes = (data.get("result") or {}).get("routes") or []
    if not routes:
        raise ValueError("百度未返回可用路线（可能起终点不可达）")
    route = routes[0]
    return {"km": route["distance"] / 1000.0, "min": route["duration"] / 60.0}


def handle_baidu_driving(body, headers_in):
    try:
        url = build_baidu_driving_url(
            resolve_baidu_ak(headers_in.get("X-Baidu-Ak")),
            body.get("from") or [], body.get("to") or [],
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    baidu_gate()  # 2 QPS 全局节流（并发请求在此排队）
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        return {"ok": False, "error": f"百度返回 {exc.code}：{detail}"}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"ok": False, "error": f"百度连接失败：{exc}"}
    except json.JSONDecodeError:
        return {"ok": False, "error": "百度响应不是合法 JSON"}
    try:
        out = parse_baidu_driving(data)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, **out}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        # 演示工具：静态文件永远重新校验，避免浏览器缓存旧 JS 导致"改了没生效"
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/travel.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/api/ai-config":
            return self._send(ai_config())
        if path == "/api/baidu-config":
            return self._send(baidu_config())
        return super().do_GET()

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            path = self.path.split("?")[0]
            if path == "/api/llm":
                return self._send(handle_llm(body, self.headers))
            if path == "/api/baidu/driving":
                return self._send(handle_baidu_driving(body, self.headers))
            self._send({"error": "not found"}, 404)
        except Exception as exc:  # 演示环境：把错误原样吐给前端，方便现场排查
            self._send({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def log_message(self, fmt_, *args):
        pass


def main():
    host, port = "127.0.0.1", 8765
    argv = sys.argv
    if "--host" in argv:
        host = argv[argv.index("--host") + 1]
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])
    srv = None
    for p in range(port, port + 10):
        try:
            srv = ThreadingHTTPServer((host, p), Handler)
            port = p
            break
        except OSError:
            continue
    if srv is None:
        raise SystemExit("端口被占用，换个 --port")
    print(f"行程编排原型已启动：http://{host}:{port}")
    if host == "0.0.0.0":
        import socket
        try:
            ip = socket.gethostbyname(socket.gethostname())
            print(f"手机同一 WiFi 打开：http://{ip}:{port}")
        except OSError:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
