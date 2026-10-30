"""最小 HTTP 服务：静态页 + JSON 接口。

只用标准库（http.server），队友只要有 Python 就能跑，不用装任何东西。

    python serve.py                 # http://127.0.0.1:8765
    python serve.py --host 0.0.0.0  # 手机同一 WiFi 下访问 http://<你的IP>:8765

接口：
    GET  /api/meta       景点池 + 默认参数
    POST /api/plan       生成行程
    POST /api/toggle     勾选/取消一个景点，返回新行程 + 代价 diff
    POST /api/replan     某一天下雨，局部重排
    GET  /api/ai-config  本地可用的 LLM 渠道（按环境变量探测）
    POST /api/llm        OpenAI 兼容 LLM 代理（浏览器跨域/key 不落盘的解决方案）

LLM key 环境变量：DEEPSEEK_API_KEY / OPENROUTER_API_KEY / SILICONFLOW_API_KEY /
HUAWEI_MAAS_API_KEY / LLM_API_KEY（通用兜底）；请求头 X-Api-Key 优先于环境变量。
"""

import json
import os
import sys
import threading
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from engine.models import Access, Place, fmt, load_pois
from engine.planner import Config, Planner
from engine.providers.transit import ChengduTransit
from engine.serialize import trip_json
from engine.validator import validate

DATA = ROOT / "engine" / "data"
WEB = ROOT / "web"

POIS = load_pois(DATA / "chengdu_pois.json")
METRO = json.loads((DATA / "chengdu_metro.json").read_text(encoding="utf-8"))
HOTEL = Place("hotel", "酒店（春熙路）", 30.6545, 104.0800, Access("春熙路", "D", 150))
PLANNER = Planner(POIS, ChengduTransit(METRO), HOTEL)
LOCK = threading.RLock()

PACE = {
    "轻松": (4500, "09:30", "20:00"),
    "标准": (6000, "09:00", "21:00"),
    "紧凑": (8000, "08:30", "22:00"),
}


def cfg_from(b):
    pace = b.get("pace", "标准")
    walk, ds, de = PACE.get(pace, PACE["标准"])
    return Config.profile(
        party=b.get("party", "成人"),
        budget=float(b.get("budget", 1500)),
        walk_limit=walk,
        start_weekday=int(b.get("start_weekday", 6)),
        day_start=ds,
        day_end=de,
    )


def plan_for(b):
    ids = [i for i in b.get("ids", []) if i in POIS]
    days = max(1, min(5, int(b.get("days", 3))))
    return PLANNER.plan(ids, days, cfg_from(b))


def meta():
    return {
        "city": "成都",
        "hotel": "酒店（春熙路）",
        "defaults": {"days": 3, "party": "老人", "pace": "标准",
                     "budget": 1500, "start_weekday": 5},
        "pois": [
            {
                "id": p.id, "name": p.name, "category": p.category,
                "tags": list(p.tags), "ticket": p.ticket,
                "suggest_min": p.suggest_min, "satisfaction": p.satisfaction,
                "indoor": p.indoor, "rain_ok": p.rain_ok,
                "open": fmt(p.open_min), "close": fmt(p.close_min),
                "note": p.note,
            }
            for p in POIS.values()
        ],
    }


def handle_plan(b):
    trip = plan_for(b)
    return {"trip": trip_json(trip, POIS), "violations": validate(trip, PLANNER)}


def handle_toggle(b):
    pid = b.get("pid")
    if pid not in POIS:
        return {"error": "unknown poi"}
    base = plan_for(b)
    adding = pid not in b.get("ids", [])
    if pid in base.ids:
        res = PLANNER.remove_poi(base, pid)
    else:
        res = PLANNER.add_poi(base, pid)
    if res is None:
        return {"error": "no change"}
    if res.get("impossible"):
        return {
            "action": "add", "impossible": True, "name": POIS[pid].name,
            "trip": trip_json(base, POIS), "violations": validate(base, PLANNER),
            "delta": res["delta"], "dropped": [],
            "seconds": round(res["seconds"] * 1000, 1),
        }
    new = res["trip"]
    return {
        "action": "add" if adding else "remove",
        "impossible": False,
        "name": POIS[pid].name,
        "trip": trip_json(new, POIS),
        "violations": validate(new, PLANNER),
        "delta": res["delta"],
        "dropped": [{"id": i, "name": POIS[i].name} for i in res["dropped"]],
        "seconds": round(res["seconds"] * 1000, 1),
    }


def handle_replan(b):
    trip = plan_for(b)
    day = max(1, min(trip.days, int(b.get("day", 1))))
    PLANNER.replan_day(trip, day, mode=b.get("mode", "rain"))
    return {"trip": trip_json(trip, POIS), "violations": validate(trip, PLANNER), "day": day}


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
        if path == "/api/meta":
            return self._send(meta())
        if path == "/api/ai-config":
            return self._send(ai_config())
        return super().do_GET()

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            path = self.path.split("?")[0]
            if path == "/api/llm":
                return self._send(handle_llm(body, self.headers))
            with LOCK:
                if path == "/api/plan":
                    return self._send(handle_plan(body))
                if path == "/api/toggle":
                    return self._send(handle_toggle(body))
                if path == "/api/replan":
                    return self._send(handle_replan(body))
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
