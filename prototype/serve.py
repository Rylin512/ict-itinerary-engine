"""最小 HTTP 服务：跨城规划页静态托管 + LLM / 百度地图代理。

只用标准库（http.server），队友只要有 Python 就能跑，不用装任何东西。
（单城编排引擎保留在 engine/，通过命令行 run_demo.py 演示，不再提供 Web 接口。）

    python serve.py                 # http://127.0.0.1:8765 （根路径重定向到 /travel.html）
    python serve.py --host 0.0.0.0  # 手机同一 WiFi 下访问 http://<你的IP>:8765

接口：
    GET  /api/ai-config      本地可用的 LLM 渠道探测（key 只报有无，不回传内容）
    POST /api/llm            OpenAI 兼容 LLM 代理（解决浏览器 CORS 与 key 不落盘）
    GET  /api/baidu-config   百度 AK 探测（服务器端 AK 是否就绪 + 浏览器端 AK）
    GET  /api/tiles/{z}/{x}/{y}.png  高德栅格瓦片代理（客户端直连失败时的底图兜底）
    POST /api/baidu/place    百度地点检索代理（酒店 / 景点，带真实出入口坐标）
    POST /api/baidu/suggest  百度地点输入提示代理（模糊搜索候选）
    POST /api/baidu/detail   百度地点详情代理（按 uid 取 navi_location 出入口）
    POST /api/baidu/route    百度多模式路线代理（driving/walking/riding/transit，返回完整折线）
    POST /api/baidu/driving  兼容旧接口：驾车路线（同样返回完整折线）

LLM key 环境变量：DEEPSEEK_API_KEY / OPENROUTER_API_KEY / SILICONFLOW_API_KEY /
HUAWEI_MAAS_API_KEY / LLM_API_KEY（通用兜底）；请求头 X-Api-Key 优先于环境变量。
百度地图 AK：环境变量 BAIDU_MAP_AK 或请求头 X-Baidu-Ak，用于 /api/baidu/driving
代理百度 Web 服务路线规划（浏览器跨域 / AK 不落盘）。
"""

import json
import os
import socket
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


# ================= 百度地图开放平台代理（地点检索 + 多模式路线规划） =================
# 浏览器直连 Web 服务 API 会被 CORS 拦且 AK 暴露；本地 serve.py 转发。
# AK 优先级：请求头 X-Baidu-Ak > 环境变量 BAIDU_MAP_AK。
# 个人认证 AK 的地点检索与路线规划均为 2 次/秒：所有上游调用共用 baidu_gate() 全局闸门。

BAIDU_PLACE_URL = "https://api.map.baidu.com/place/v2/search"
BAIDU_SUGGEST_URL = "https://api.map.baidu.com/place/v2/suggestion"
BAIDU_DETAIL_URL = "https://api.map.baidu.com/place/v2/detail"
BAIDU_ROUTE_URLS = {
    "driving": "https://api.map.baidu.com/direction/v2/driving",
    "walking": "https://api.map.baidu.com/direction/v2/walking",
    "riding": "https://api.map.baidu.com/direction/v2/riding",
    "transit": "https://api.map.baidu.com/direction/v2/transit",
}
BAIDU_DRIVING_URL = BAIDU_ROUTE_URLS["driving"]
MAX_PATH_POINTS = 1200

# 个人认证 AK 的路线规划限 2 次/秒：代理层全局节流，相邻上游调用间隔 ≥0.55s。
# 多个前端并发请求在闸门前排队，保证任何时刻都不会超限。
# 地点检索/详情是用户等待的交互，标记 priority 后可插到路线请求前面；
# 否则一次行程要发十几条路线请求，搜索要排在它们后面干等十几秒。
BAIDU_MIN_INTERVAL = 0.55
_BAIDU_GATE = threading.Condition()
_BAIDU_LAST_CALL = [0.0]
_BAIDU_WAITING = {"priority": 0, "normal": 0}


def baidu_gate(priority=False):
    """全局 2 QPS 节流；priority=True 的请求优先占用下一个时间片。"""
    cls = "priority" if priority else "normal"
    with _BAIDU_GATE:
        _BAIDU_WAITING[cls] += 1
        try:
            while True:
                now = time.monotonic()
                due = _BAIDU_LAST_CALL[0] + BAIDU_MIN_INTERVAL - now
                # 普通请求要给正在等待的地点检索让路（它们通常只等一两个时间片）
                has_priority = _BAIDU_WAITING["priority"] > 0
                if due <= 0 and (cls == "priority" or not has_priority):
                    _BAIDU_LAST_CALL[0] = now
                    return
                _BAIDU_GATE.wait(None if due <= 0 else due)
        finally:
            _BAIDU_WAITING[cls] -= 1
            _BAIDU_GATE.notify_all()


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


def _latlng_pair(pair, label):
    """[lng, lat] -> 百度要求的「纬度,经度」字符串（两者都做合法性校验）。"""
    if not isinstance(pair, (list, tuple)) or len(pair) != 2:
        raise ValueError(f"{label} 需为 [经度, 纬度] 二元组")
    return f"{_coord(pair[1])},{_coord(pair[0])}"


def build_baidu_place_url(ak, query, region, page_size=10, page_num=0):
    """地点检索：scope=2 取详情，ret_coordtype=gcj02ll 让坐标保持 GCJ-02。

    页面里的景点/酒店坐标都是 GCJ-02，若用百度默认的 BD-09 回包会整体偏移数百米；
    这里显式要 GCJ-02，前端就能直接和现有数据混用。纯函数便于单测。
    """
    if not ak:
        raise ValueError("未找到百度 AK：请在设置面板填写，或为 serve.py 设置环境变量 BAIDU_MAP_AK")
    q = str(query or "").strip()
    region = str(region or "").strip()
    if not q:
        raise ValueError("搜索关键词不能为空")
    if not region:
        raise ValueError("搜索城市不能为空")
    try:
        ps = max(1, min(int(page_size or 10), 20))
        pn = max(0, int(page_num or 0))
    except (TypeError, ValueError):
        raise ValueError("pageSize / pageNum 需为整数")
    from urllib.parse import quote
    return (f"{BAIDU_PLACE_URL}?query={quote(q)}&region={quote(region)}"
            f"&output=json&scope=2&ret_coordtype=gcj02ll"
            f"&page_size={ps}&page_num={pn}&ak={quote(ak)}")


def build_baidu_suggest_url(ak, query, region=None, city_limit=True):
    """地点输入提示（模糊搜索）：适合用户只记得「春熙路 全季」这类半截关键词。

    place/v2/search 要求关键词能命中 POI 名称，模糊组合经常只回空结果；
    suggestion 却能把候选一次列全。ret_coordtype=gcj02ll 保证回包是 GCJ-02
    （只写 gcj02 会返回 BD-09，和页面坐标差几百米）。纯函数便于单测。
    """
    if not ak:
        raise ValueError("未找到百度 AK：请在设置面板填写，或为 serve.py 设置环境变量 BAIDU_MAP_AK")
    q = str(query or "").strip()
    region = str(region or "").strip()
    if not q:
        raise ValueError("搜索关键词不能为空")
    from urllib.parse import quote
    url = (f"{BAIDU_SUGGEST_URL}?query={quote(q)}&output=json"
           f"&ret_coordtype=gcj02ll")
    if region:
        url += f"&region={quote(region)}&city_limit={'true' if city_limit else 'false'}"
    return f"{url}&ak={quote(ak)}"


def build_baidu_detail_url(ak, uid):
    """地点详情：用 suggestion 返回的 uid 换取 detail_info.navi_location（真实出入口）。"""
    if not ak:
        raise ValueError("未找到百度 AK：请在设置面板填写，或为 serve.py 设置环境变量 BAIDU_MAP_AK")
    uid = str(uid or "").strip()
    if not uid:
        raise ValueError("缺少地点 uid")
    from urllib.parse import quote
    return (f"{BAIDU_DETAIL_URL}?uid={quote(uid)}&output=json&scope=2"
            f"&ret_coordtype=gcj02ll&ak={quote(ak)}")


def build_baidu_route_url(ak, from_pair, to_pair, mode="driving", city1=None, city2=None):
    """多模式路线规划：driving / walking / riding / transit。

    from/to 为 [lng, lat]（GCJ-02），百度要求 origin/destination 为「纬度,经度」。
    coord_type=gcj02 声明入参坐标系，ret_coordtype=gcj02 让回包 path 也用 GCJ-02。
    公交（transit）必须带 city1 / city2（城市名或城市编码）。纯函数便于单测。
    """
    if not ak:
        raise ValueError("未找到百度 AK：请在设置面板填写，或为 serve.py 设置环境变量 BAIDU_MAP_AK")
    if mode not in BAIDU_ROUTE_URLS:
        raise ValueError(f"不支持的路线方式：{mode}")
    o = _latlng_pair(from_pair, "from")
    d = _latlng_pair(to_pair, "to")
    url = (f"{BAIDU_ROUTE_URLS[mode]}?origin={o}&destination={d}"
           f"&coord_type=gcj02&ret_coordtype=gcj02&ak={ak}")
    if mode == "transit":
        c1, c2 = str(city1 or "").strip(), str(city2 or "").strip()
        if not c1 or not c2:
            raise ValueError("公交路线需要 city1 / city2（城市名或城市编码）")
        from urllib.parse import quote
        url += f"&city1={quote(c1)}&city2={quote(c2)}"
    return url


def build_baidu_driving_url(ak, from_pair, to_pair):
    """兼容旧接口：驾车路线。"""
    return build_baidu_route_url(ak, from_pair, to_pair, "driving")


def _lnglat(obj):
    """把 {'lng':..,'lat':..} 或 "lng,lat" 统一成 (lng, lat)，失败返回 None。"""
    if isinstance(obj, dict):
        try:
            return float(obj["lng"]), float(obj["lat"])
        except (KeyError, TypeError, ValueError):
            return None
    if isinstance(obj, str) and "," in obj:
        parts = obj.split(",")
        if len(parts) >= 2:
            try:
                return float(parts[0]), float(parts[1])
            except ValueError:
                return None
    return None


def _check_baidu_status(data):
    status = data.get("status")
    if status != 0:
        raise ValueError(f"百度返回 status={status}：{data.get('message', '未知错误')}")


def _parse_place_item(item):
    """search / detail / suggestion 三种回包的公共字段，缺失坐标返回 None。

    每项同时给「地址坐标」(lng/lat) 与「导航点坐标」(navLng/navLat)：
    后者来自 detail_info.navi_location，是酒店/景区真正的大门或出入口位置；
    没给导航点时回退到地址坐标，hasNav 标记是否真的拿到了出入口。
    suggestion 没有 detail_info，hasNav 为 False，等用户选中后再查详情。
    """
    loc = _lnglat(item.get("location"))
    if not loc:
        return None
    detail = item.get("detail_info") or {}
    nav = _lnglat(detail.get("navi_location"))
    return {
        "name": item.get("name") or "",
        "address": item.get("address") or "",
        "lng": loc[0], "lat": loc[1],
        "navLng": nav[0] if nav else loc[0],
        "navLat": nav[1] if nav else loc[1],
        "hasNav": bool(nav),
        "tag": detail.get("tag") or item.get("tag") or "",
        "uid": item.get("uid") or "",
        "tel": detail.get("phone") or item.get("telephone") or "",
    }


def parse_baidu_place(data):
    """解析 place/v2/search 回包（精确 POI 检索，带出入口坐标）。"""
    _check_baidu_status(data)
    places = []
    for item in data.get("results") or []:
        parsed = _parse_place_item(item)
        if parsed:
            places.append(parsed)
    return places


def parse_baidu_suggest(data):
    """解析 place/v2/suggestion 回包（模糊搜索候选，可能没有 navi_location）。"""
    _check_baidu_status(data)
    places = []
    for item in data.get("result") or []:
        place = _parse_place_item(item)
        if not place:
            continue
        if not place["address"]:
            # suggestion 常把行政区拆成 city/district，拼起来给用户看
            parts = [item.get("city") or "", item.get("district") or ""]
            place["address"] = "".join(dict.fromkeys(p for p in parts if p))
        places.append(place)
    return places


def parse_baidu_detail(data):
    """解析 place/v2/detail 回包，返回单个地点（含 navi_location 出入口）。"""
    _check_baidu_status(data)
    result = data.get("result")
    if isinstance(result, list):
        result = result[0] if result else None
    if not isinstance(result, dict):
        raise ValueError("百度未返回该地点的详情")
    place = _parse_place_item(result)
    if not place:
        raise ValueError("百度详情缺少坐标")
    return place


def _append_path(dst, raw):
    """百度的 path 是 "lng,lat;lng,lat;..."，追加到 dst 并去掉重复点。"""
    if not raw or not isinstance(raw, str):
        return
    for token in raw.split(";"):
        token = token.strip()
        if not token:
            continue
        try:
            lng_s, lat_s = token.split(",")[:2]
            lng, lat = float(lng_s), float(lat_s)
        except (ValueError, TypeError):
            continue
        if dst and abs(dst[-1][0] - lng) < 1e-7 and abs(dst[-1][1] - lat) < 1e-7:
            continue
        dst.append([lng, lat])


def _collect_paths(node, dst):
    """递归收集 steps 里所有 path；公交的 steps 是数组套数组，也一并处理。"""
    if isinstance(node, dict):
        _append_path(dst, node.get("path"))
        for key, value in node.items():
            if key != "path" and isinstance(value, (dict, list)):
                _collect_paths(value, dst)
    elif isinstance(node, list):
        for item in node:
            _collect_paths(item, dst)


def _thin_path(path):
    """路线点太多会拖慢前端绘制，等距抽稀到 MAX_PATH_POINTS 以内（保留首尾）。"""
    if len(path) <= MAX_PATH_POINTS:
        return path
    step = (len(path) - 1) / (MAX_PATH_POINTS - 1)
    return [path[round(i * step)] for i in range(MAX_PATH_POINTS)]


def parse_baidu_route(data, mode="driving"):
    """从 direction/v2 响应提取 km / min / 完整折线 path（GCJ-02）。

    path 是所有 step 的折线按顺序拼接、去重后的结果，直接画在图上即为真实道路，
    而不是点到点的直线。公交路线可能还带 price（元）。
    """
    status = data.get("status")
    if status != 0:
        raise ValueError(f"百度返回 status={status}：{data.get('message', '未知错误')}")
    result = data.get("result") or {}
    routes = result.get("routes") or []
    if not routes:
        raise ValueError("百度未返回可用路线（可能起终点不可达）")
    route = routes[0]
    path = []
    _collect_paths(route.get("steps") or [], path)
    if not path:
        # 极少数回包没有 steps.path：退回起终点直线，至少不中断页面
        o = _lnglat(result.get("origin"))
        d = _lnglat(result.get("destination"))
        if o and d:
            path = [[o[0], o[1]], [d[0], d[1]]]
    out = {
        "mode": mode,
        "km": round(float(route.get("distance") or 0) / 1000.0, 2),
        "min": round(float(route.get("duration") or 0) / 60.0, 1),
        "path": _thin_path(path),
    }
    if route.get("price") is not None:
        try:
            out["cost"] = float(route["price"])
        except (TypeError, ValueError):
            pass
    return out


def parse_baidu_driving(data):
    """兼容旧接口：只取驾车 (km, min)。"""
    out = parse_baidu_route(data, "driving")
    return {"km": out["km"], "min": out["min"]}


def _baidu_request(url, timeout=15, priority=False):
    """调用百度 Web 服务 API：全局 2 QPS 节流 + 统一错误文案，返回 (data, error)。"""
    baidu_gate(priority)  # 2 QPS 全局节流（并发请求在此排队）
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        return None, f"百度返回 {exc.code}：{detail}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return None, f"百度连接失败：{exc}"
    except json.JSONDecodeError:
        return None, "百度响应不是合法 JSON"


def handle_baidu_place(body, headers_in):
    try:
        url = build_baidu_place_url(
            resolve_baidu_ak(headers_in.get("X-Baidu-Ak")),
            body.get("query") or "",
            body.get("region") or body.get("city") or "",
            body.get("pageSize") or 10,
            body.get("pageNum") or 0,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    data, err = _baidu_request(url, priority=True)
    if err:
        return {"ok": False, "error": err}
    try:
        places = parse_baidu_place(data)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "places": places}


def handle_baidu_suggest(body, headers_in):
    """模糊搜索：返回候选列表，用户点选后再走 /api/baidu/detail 取出入口。"""
    try:
        city_limit = body.get("cityLimit")
        url = build_baidu_suggest_url(
            resolve_baidu_ak(headers_in.get("X-Baidu-Ak")),
            body.get("query") or "",
            body.get("region") or body.get("city") or "",
            True if city_limit is None else bool(city_limit),
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    data, err = _baidu_request(url, priority=True)
    if err:
        return {"ok": False, "error": err}
    try:
        places = parse_baidu_suggest(data)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "places": places}


def handle_baidu_detail(body, headers_in):
    try:
        url = build_baidu_detail_url(
            resolve_baidu_ak(headers_in.get("X-Baidu-Ak")),
            body.get("uid") or "",
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    data, err = _baidu_request(url, priority=True)
    if err:
        return {"ok": False, "error": err}
    try:
        place = parse_baidu_detail(data)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "place": place}


def handle_baidu_route(body, headers_in):
    try:
        url = build_baidu_route_url(
            resolve_baidu_ak(headers_in.get("X-Baidu-Ak")),
            body.get("from") or [], body.get("to") or [],
            body.get("mode") or "driving",
            body.get("city1"), body.get("city2"),
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    data, err = _baidu_request(url)
    if err:
        return {"ok": False, "error": err}
    try:
        out = parse_baidu_route(data, body.get("mode") or "driving")
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, **out}


def handle_baidu_driving(body, headers_in):
    try:
        url = build_baidu_driving_url(
            resolve_baidu_ak(headers_in.get("X-Baidu-Ak")),
            body.get("from") or [], body.get("to") or [],
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    data, err = _baidu_request(url)
    if err:
        return {"ok": False, "error": err}
    try:
        out = parse_baidu_route(data, "driving")
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, **out}


# ================= 地图瓦片代理（Leaflet 底图兜底） =================
# 设备/浏览器直连瓦片服务偶尔会被网络策略拦住（本机 Firefox 沙箱就是如此）；
# 由本地 serve.py 代取高德瓦片并缓存，页面在 OSM 不可达时改用
# /api/tiles/{z}/{x}/{y}.png，保证底图在任何客户端都能显示。
AMAP_TILE_URL = ("https://webrd0{sub}.is.autonavi.com/appmaptile"
                 "?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}")
_TILE_CACHE = {}
_TILE_CACHE_MAX = 4000
_TILE_LOCK = threading.Lock()


def parse_tile_path(path):
    """/api/tiles/{z}/{x}/{y}.png -> (z, x, y)；非法路径返回 None。"""
    if not path.startswith("/api/tiles/"):
        return None
    parts = path.strip("/").split("/")
    if len(parts) != 5:
        return None
    try:
        z, x = int(parts[2]), int(parts[3])
        y = int(parts[4].split(".")[0])
    except (TypeError, ValueError):
        return None
    if not (0 <= z <= 18 and 0 <= x < (1 << z) and 0 <= y < (1 << z)):
        return None
    return z, x, y


def fetch_amap_tile(z, x, y):
    """取一张高德栅格瓦片（GCJ-02，与页面坐标一致），内存缓存。"""
    key = (z, x, y)
    with _TILE_LOCK:
        cached = _TILE_CACHE.get(key)
    if cached:
        return cached
    url = AMAP_TILE_URL.format(sub=1 + ((x + y) % 4), x=x, y=y, z=z)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; ict-itinerary-engine/1.0)",
        "Referer": "https://www.amap.com/",
    })
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = resp.read()
    if data:
        with _TILE_LOCK:
            if len(_TILE_CACHE) >= _TILE_CACHE_MAX:
                _TILE_CACHE.clear()
            _TILE_CACHE[key] = data
    return data


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        # 演示工具：静态文件永远重新校验，避免浏览器缓存旧 JS 导致"改了没生效"
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # 用户切页/连点搜索时浏览器会主动断开，属正常情况，不该刷错误栈
            self.close_connection = True

    def _send_bytes(self, data, content_type, code=200):
        try:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

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
        if path.startswith("/api/tiles/"):
            tile = parse_tile_path(path)
            if not tile:
                return self._send({"error": "bad tile path"}, 400)
            try:
                data = fetch_amap_tile(*tile)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                return self._send({"error": f"tile upstream failed: {exc}"}, 502)
            return self._send_bytes(data, "image/png")
        return super().do_GET()

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            path = self.path.split("?")[0]
            if path == "/api/llm":
                return self._send(handle_llm(body, self.headers))
            if path == "/api/baidu/place":
                return self._send(handle_baidu_place(body, self.headers))
            if path == "/api/baidu/suggest":
                return self._send(handle_baidu_suggest(body, self.headers))
            if path == "/api/baidu/detail":
                return self._send(handle_baidu_detail(body, self.headers))
            if path == "/api/baidu/route":
                return self._send(handle_baidu_route(body, self.headers))
            if path == "/api/baidu/driving":
                return self._send(handle_baidu_driving(body, self.headers))
            self._send({"error": "not found"}, 404)
        except Exception as exc:  # 演示环境：把错误原样吐给前端，方便现场排查
            self._send({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def log_message(self, fmt_, *args):
        pass


class DualStackHTTPServer(ThreadingHTTPServer):
    """监听 0.0.0.0 时同时接受 IPv6（::1），避免 Safari 优先解析 localhost 到 IPv6 后连不上。"""

    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def main():
    host, port = "127.0.0.1", 8765
    argv = sys.argv
    if "--host" in argv:
        host = argv[argv.index("--host") + 1]
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])
    # 0.0.0.0 表示监听全部网卡；双栈绑定 :: 同时覆盖 IPv4 与 IPv6。
    bind_host = "::" if host in ("0.0.0.0", "::") else host
    server_cls = DualStackHTTPServer if bind_host == "::" else ThreadingHTTPServer
    srv = None
    for p in range(port, port + 10):
        try:
            srv = server_cls((bind_host, p), Handler)
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
