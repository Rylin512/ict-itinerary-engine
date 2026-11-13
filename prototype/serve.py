"""最小 HTTP 服务：跨城规划页静态托管 + LLM / 百度地图代理。

只用标准库（http.server），队友只要有 Python 就能跑，不用装任何东西。
（单城编排引擎保留在 engine/，通过命令行 run_demo.py 演示，不再提供 Web 接口。）

    python serve.py                 # http://127.0.0.1:8765 （根路径重定向到 /travel.html）
    python serve.py --host 0.0.0.0  # 手机同一 WiFi 下访问 http://<你的IP>:8765

接口：
    GET  /api/ai-config      本地可用的 LLM 渠道探测（key 只报有无，不回传内容）
    POST /api/llm            OpenAI 兼容 LLM 代理（解决浏览器 CORS 与 key 不落盘）
    GET  /api/baidu-config   百度 AK 探测（服务器端 AK 是否就绪 + 浏览器端 AK）
    GET  /api/rail-stations  免费火车站搜索（12306 车站库，本机缓存 7 天，不占百度配额）
    GET  /api/free/places    免费地点搜索（OpenStreetMap / Nominatim，缓存 30 天）
    GET  /api/free/attractions 免费景点发现（OpenStreetMap / Overpass，缓存 7 天）
    GET  /api/cache/config   持久缓存统计 + 当前体积上限
    POST /api/cache/config   修改缓存体积上限（{"maxMb": 500}），超限按使用频率淘汰
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

百度结果（地点检索 / 模糊提示 / 详情 / 各模式路线）默认持久化在
prototype/.cache/baidu.sqlite3，不按时间过期；默认上限 500MB，超过后按
「命中次数低 → 最久未使用」自动淘汰（BAIDU_CACHE_MAX_MB 可改默认值，
页面设置面板或 /api/cache/config 可在线修改）。BAIDU_CACHE=0 关闭缓存。
"""

import hashlib
import json
import math
import os
import socket
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"


# ================= 百度结果持久缓存（减少每天有限的 API 配额） =================
# 地点检索 / 模糊提示 / 详情 / 路线全部落盘，默认不按时间过期；
# 只有缓存体积超过上限时才按「使用频率（命中次数）低 → 最近最少使用」淘汰。
# 存储用 SQLite（标准库）：单条写入不再重写整个文件，手机端也不会把 500MB 读进内存。
CACHE_ENABLED = os.environ.get("BAIDU_CACHE", "1") != "0"
CACHE_DIR = Path(os.environ.get("BAIDU_CACHE_DIR") or (ROOT / ".cache"))
CACHE_FILE = CACHE_DIR / "baidu.json"       # 旧版 JSON 缓存：仅用于一次性迁移
CACHE_MAX_MB_DEFAULT = 500
CACHE_MAX_MB_MIN = 10
CACHE_MAX_MB_MAX = 10240
CACHE_EVICT_RATIO = 0.9                     # 超限后回收到上限的 90%，避免每次写入都触发淘汰
PLACE_TTL = None                            # None = 不按时间过期，交给体积淘汰
ROUTE_TTL = None
ROUTE_CACHE_VERSION = 3  # 3：坐标按 4 位小数归一化后再做键，旧键自然失效
FREE_PLACE_TTL = 30 * 86400
FREE_POI_TTL = 7 * 86400
SEARCH_TTL = 6 * 3600  # 联网搜索结果：同一 query 6 小时内不重复计费
FREE_MIN_INTERVAL = 1.0  # Nominatim / Overpass 公共服务的礼貌间隔（≤1 次/秒）
_CACHE = None  # 兼容旧测试：置 None 后下次访问会重新打开数据库
_DB = None
_DB_PATH = None
_CACHE_LOCK = threading.RLock()  # 可重入：淘汰逻辑会在持锁时再读上限配置


def _cache_db_path():
    return CACHE_FILE.with_suffix(".sqlite3")


def _cache_connect():
    """打开（或复用）缓存数据库；路径随 CACHE_FILE 变化，方便测试隔离。"""
    global _DB, _DB_PATH, _CACHE
    path = _cache_db_path()
    if _DB is not None and _DB_PATH == path:
        return _DB
    if _DB is not None:
        try:
            _DB.close()
        except sqlite3.Error:
            pass
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path), timeout=15, check_same_thread=False)
    # auto_vacuum 必须在建表前开启：删除低频条目后文件会自动收缩
    db.execute("PRAGMA auto_vacuum=FULL")
    db.execute("""
        CREATE TABLE IF NOT EXISTS cache (
            section  TEXT NOT NULL,
            key      TEXT NOT NULL,
            value    TEXT NOT NULL,
            created  REAL NOT NULL,
            accessed REAL NOT NULL,
            hits     INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (section, key)
        )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_cache_evict ON cache(hits, accessed)")
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.commit()
    _DB, _DB_PATH, _CACHE = db, path, db
    _cache_migrate_json(db)
    return db


def _cache_migrate_json(db):
    """把旧版 baidu.json 导入 SQLite，升级后不必重新消耗百度配额。"""
    legacy = CACHE_FILE
    if not legacy.exists():
        return
    done = db.execute("SELECT value FROM meta WHERE key='json_migrated'").fetchone()
    if done:
        return
    try:
        raw = json.loads(legacy.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    now = time.time()
    imported = 0
    for section in ("places", "routes", "free_places", "free_pois"):
        for key, item in (raw.get(section) or {}).items():
            val = item.get("v") if isinstance(item, dict) else item
            if val is None:
                continue
            ts = float(item.get("t") or now) if isinstance(item, dict) else now
            try:
                db.execute(
                    "INSERT OR IGNORE INTO cache(section,key,value,created,accessed,hits) "
                    "VALUES(?,?,?,?,?,1)",
                    (section, key, json.dumps(val, ensure_ascii=False), ts, ts))
                imported += 1
            except (sqlite3.Error, TypeError, ValueError):
                continue
    db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('json_migrated',?)",
               (str(int(now)),))
    db.commit()
    if imported:
        try:
            legacy.rename(legacy.with_suffix(".json.migrated"))
        except OSError:
            pass


def _clamp_max_mb(mb):
    try:
        mb = float(mb)
    except (TypeError, ValueError):
        mb = CACHE_MAX_MB_DEFAULT
    return max(CACHE_MAX_MB_MIN, min(CACHE_MAX_MB_MAX, mb))


def cache_max_mb():
    if not CACHE_ENABLED:
        return _clamp_max_mb(os.environ.get("BAIDU_CACHE_MAX_MB") or CACHE_MAX_MB_DEFAULT)
    try:
        with _CACHE_LOCK:
            row = _cache_connect().execute(
                "SELECT value FROM meta WHERE key='max_mb'").fetchone()
        if row:
            return _clamp_max_mb(row[0])
    except sqlite3.Error:
        pass
    return _clamp_max_mb(os.environ.get("BAIDU_CACHE_MAX_MB") or CACHE_MAX_MB_DEFAULT)


def cache_max_bytes():
    return int(cache_max_mb() * 1024 * 1024)


def _cache_disk_bytes():
    total = 0
    base = str(_cache_db_path())
    for suffix in ("", "-journal", "-wal", "-shm"):
        try:
            total += os.path.getsize(base + suffix)
        except OSError:
            pass
    return total


def _cache_payload_bytes(db):
    row = db.execute("SELECT COALESCE(SUM(length(value)), 0) FROM cache").fetchone()
    return int(row[0] or 0)


def _cache_evict_if_needed(db=None):
    """超过上限时按命中次数从低到高淘汰，同频次按最久未使用优先。"""
    if not CACHE_ENABLED:
        return 0
    db = db or _cache_connect()
    cap = cache_max_bytes()
    if max(_cache_payload_bytes(db), _cache_disk_bytes()) <= cap:
        return 0
    target = int(cap * CACHE_EVICT_RATIO)
    removed = 0
    while True:
        payload = _cache_payload_bytes(db)
        if payload <= target:
            break
        rows = db.execute(
            "SELECT section, key, length(value) FROM cache "
            "ORDER BY hits ASC, accessed ASC LIMIT 2000"
        ).fetchall()
        if not rows:
            break
        # 只删到刚好回落到目标体积，避免一次把高频条目也清掉
        need, freed, batch = payload - target, 0, []
        for section, key, size in rows:
            batch.append((section, key))
            freed += int(size or 0)
            if freed >= need:
                break
        if not batch:
            break
        db.executemany("DELETE FROM cache WHERE section=? AND key=?", batch)
        db.commit()
        removed += len(batch)
    return removed


def cache_key(section, payload):
    raw = section + "|" + json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def point_key(pair, ndigits=6):
    """缓存键里的坐标精度：6 位小数 ≈ 0.11 米，保证"米级以内算同一个点"。

    之前用 4 位（≈11 米）是为了提高命中率，但会把相距十几米的两个上车点
    当成同一条路线，精度不够。现在上游请求本来就用原始坐标，缓存键只决定
    "两次请求是否算同一个点"，取 6 位既不丢精度，也让同样的输入稳定命中。
    """
    try:
        return [round(float(pair[0]), ndigits), round(float(pair[1]), ndigits)]
    except (TypeError, ValueError, IndexError):
        return pair


def cache_get(section, key, ttl=None):
    if not CACHE_ENABLED or not key:
        return None
    now = time.time()
    with _CACHE_LOCK:
        db = _cache_connect()
        row = db.execute(
            "SELECT value, created FROM cache WHERE section=? AND key=?",
            (section, key)).fetchone()
        if not row:
            return None
        if ttl is not None and now - float(row[1]) > ttl:
            db.execute("DELETE FROM cache WHERE section=? AND key=?", (section, key))
            db.commit()
            return None
        # 命中计数是淘汰依据：读一次记一次
        db.execute(
            "UPDATE cache SET hits=hits+1, accessed=? WHERE section=? AND key=?",
            (now, section, key))
        db.commit()
        try:
            return json.loads(row[0])
        except ValueError:
            db.execute("DELETE FROM cache WHERE section=? AND key=?", (section, key))
            db.commit()
            return None


def cache_set(section, key, value):
    if not CACHE_ENABLED or not key:
        return
    now = time.time()
    try:
        text = json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return
    with _CACHE_LOCK:
        db = _cache_connect()
        db.execute("""
            INSERT INTO cache(section, key, value, created, accessed, hits)
            VALUES(?, ?, ?, ?, ?, 0)
            ON CONFLICT(section, key) DO UPDATE SET
                value=excluded.value, created=excluded.created, accessed=excluded.accessed
        """, (section, key, text, now, now))
        db.commit()
        _cache_evict_if_needed(db)


def cache_stats():
    with _CACHE_LOCK:
        db = _cache_connect()
        entries = db.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
        sections = dict(db.execute(
            "SELECT section, COUNT(*) FROM cache GROUP BY section").fetchall())
        payload = _cache_payload_bytes(db)
    size = _cache_disk_bytes()
    return {
        "maxMb": cache_max_mb(),
        "sizeBytes": size,
        "sizeMb": round(size / 1048576, 2),
        "payloadMb": round(payload / 1048576, 2),
        "entries": entries,
        "sections": sections,
    }


def set_cache_max_mb(mb):
    mb = _clamp_max_mb(mb)
    with _CACHE_LOCK:
        db = _cache_connect()
        db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('max_mb', ?)", (str(mb),))
        db.commit()
        _cache_evict_if_needed(db)
    return mb


def handle_cache_config(body=None):
    if body is None:
        return {"ok": True, **cache_stats(), "defaultMaxMb": CACHE_MAX_MB_DEFAULT}
    if not isinstance(body, dict) or "maxMb" not in body:
        return {"ok": False, "error": "缺少 maxMb"}
    try:
        mb = float(body["maxMb"])
    except (TypeError, ValueError):
        return {"ok": False, "error": "maxMb 需为数字"}
    if not (CACHE_MAX_MB_MIN <= mb <= CACHE_MAX_MB_MAX):
        return {
            "ok": False,
            "error": f"缓存上限需在 {CACHE_MAX_MB_MIN}–{CACHE_MAX_MB_MAX} MB 之间",
        }
    set_cache_max_mb(mb)
    return {"ok": True, **cache_stats()}


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
        headers["X-Title"] = "itinerary-engine"
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
        # 联网搜索：key 只报有无；demo 恒可用
        "search": {p: bool(search_provider_key(p)) for p, _ in SEARCH_PROVIDER_KEYS} | {"demo": True},
    }


def call_upstream(url, headers, payload, timeout=60):
    """60s 上限与前端 AI.chat 的默认超时对齐：推理模型太慢就快速失败，
    避免页面"生成中"干等两分钟才报错（现场演示最伤观感）。"""
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


def handle_llm_models(body, headers_in):
    """列出上游可用模型（GET {baseURL}/models）。

    上游模型名会下线/改名（例如 OpenRouter 的 deepseek-r1:free 已移除），
    让前端能拉实时列表，避免"key 是对的但模型不存在"这种无从排查的失败。
    """
    try:
        base_url = (body.get("baseURL") or "").rstrip("/")
        if not base_url:
            raise ValueError("baseURL 必填")
        if not llm_allowed_host(base_url):
            raise ValueError(f"上游 {base_url} 不在白名单内")
        key = resolve_llm_key(base_url, headers_in.get("X-Api-Key"))
        if not key:
            raise ValueError("未找到 API key：请在前端填写，或为 serve.py 设置对应环境变量")
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    req = urllib.request.Request(
        base_url + "/models",
        headers={"Authorization": f"Bearer {key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        return {"ok": False, "error": f"上游返回 {exc.code}：{detail}"}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"ok": False, "error": f"上游连接失败：{exc}"}
    items = data.get("data") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return {"ok": False, "error": f"上游响应格式异常：{json.dumps(data, ensure_ascii=False)[:200]}"}
    ids = [m.get("id") for m in items if isinstance(m, dict) and m.get("id")]
    return {"ok": True, "models": ids}


# ================= 联网搜索代理（博查 / Tavily，供 AI 攻略问答引用实时网页） =================
# 国内大模型式"联网搜索"：AI 回答前先检索，回答下方列出可点击来源。
# key：请求头 X-Search-Key > 环境变量 BOCHA_API_KEY / TAVILY_API_KEY。

SEARCH_PROVIDER_KEYS = [
    ("bocha", "BOCHA_API_KEY"),
    ("tavily", "TAVILY_API_KEY"),
    ("deepseek", "DEEPSEEK_API_KEY"),   # DeepSeek 官方 Search API（按成功请求计费）
]


def search_provider_key(provider, header_key=None):
    if header_key:
        return header_key
    return os.environ.get(dict(SEARCH_PROVIDER_KEYS).get(provider, ""), None)


def build_search_request(provider, key, query, count=6):
    """整理对搜索上游的 (url, headers, payload)，纯函数便于单测。"""
    query = (query or "").strip()
    if not query:
        raise ValueError("query 必填")
    if provider == "bocha":
        if not _extra_host_ok("api.bochaai.com"):
            raise ValueError("上游 api.bochaai.com 不在白名单内")
        return ("https://api.bochaai.com/v1/web-search",
                {"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
                {"query": query, "count": int(count), "summary": True, "freshness": "noLimit"})
    if provider == "tavily":
        if not _extra_host_ok("api.tavily.com"):
            raise ValueError("上游 api.tavily.com 不在白名单内")
        return ("https://api.tavily.com/search",
                {"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
                {"query": query, "max_results": int(count)})
    if provider == "deepseek":
        if not _extra_host_ok("api.deepseek.com"):
            raise ValueError("上游 api.deepseek.com 不在白名单内")
        # 官方 Search API：https://api-docs.deepseek.com/guides/search
        return ("https://api.deepseek.com/v1/tools/search",
                {"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
                {"query": query, "count": int(count), "need_content": False})
    raise ValueError(f"未知搜索源：{provider}")


def _extra_host_ok(host):
    extra = [h.strip().lower() for h in os.environ.get("SEARCH_ALLOWED_HOSTS", "").split(",") if h.strip()]
    allowed = ["api.bochaai.com", "api.tavily.com", "api.deepseek.com"] + extra
    return any(host == h or host.endswith("." + h) for h in allowed)


def parse_search_response(provider, data):
    """把上游响应归一化为 [{title,url,snippet}]，纯函数便于单测。"""
    out = []
    if provider == "bocha":
        pages = ((data.get("data") or {}).get("webPages") or {}).get("value") or []
        for p in pages:
            if isinstance(p, dict) and p.get("url"):
                out.append({"title": p.get("name") or "", "url": p["url"],
                            "snippet": p.get("summary") or p.get("snippet") or ""})
    elif provider == "tavily":
        for p in data.get("results") or []:
            if isinstance(p, dict) and p.get("url"):
                out.append({"title": p.get("title") or "", "url": p["url"],
                            "snippet": p.get("content") or ""})
    elif provider == "deepseek":
        # 官方 Search 回包：results[] 里 summary 是给模型读的长摘要，snippet 给 UI
        for p in data.get("results") or []:
            if isinstance(p, dict) and p.get("url"):
                out.append({"title": p.get("title") or "", "url": p["url"],
                            "snippet": p.get("summary") or p.get("snippet") or ""})
    return out


def demo_search_results(query, count):
    """离线演示搜索源：无需任何 key，返回预置检索结果（明确标注演示）。
    用于答辩断网兜底 / 未注册搜索 key 时体验完整的联网问答交互。"""
    q = (query or "").strip() or "旅游"
    results = [
        {"title": f"【演示】{q} 精选推荐", "url": "https://www.example.com/demo-search/1",
         "snippet": f"关于「{q}」的演示检索摘要：本地预置数据，无需联网与 key 即可体验"
                    "「检索提示 → 引用标注 → 来源链接」的完整联网问答交互。"},
        {"title": f"【演示】{q} 实用指南", "url": "https://www.example.com/demo-search/2",
         "snippet": "演示摘要：通用区域 / 类型建议。正式接入博查 / Tavily 后，"
                    "这里将展示真实搜索引擎返回的内容。"},
        {"title": f"【演示】{q} 常见问答", "url": "https://www.example.com/demo-search/3",
         "snippet": "演示摘要：本条用于验证来源列表的展示与跳转（点击为示例链接）。"},
    ]
    return results[:max(1, min(int(count or 3), len(results)))]


def handle_web_search(body, headers_in):
    provider = (body.get("provider") or "auto").lower()
    try:
        query = body.get("query") or ""
        count = min(max(int(body.get("count") or 6), 1), 10)
        if provider == "demo":
            return {"ok": True, "provider": "demo", "results": demo_search_results(query, count)}
        if provider == "auto":
            provider = next((p for p, env in SEARCH_PROVIDER_KEYS
                             if search_provider_key(p, headers_in.get("X-Search-Key"))), None)
            if not provider:
                return {"ok": False, "error": "未配置联网搜索：请在页面填搜索 key，或为 serve.py 设置 BOCHA_API_KEY / TAVILY_API_KEY / DEEPSEEK_API_KEY 环境变量；也可把搜索源切到「离线演示」直接体验"}
        key = search_provider_key(provider, headers_in.get("X-Search-Key"))
        if not key:
            return {"ok": False, "error": f"搜索源 {provider} 未配置 key（页面填写或环境变量）"}
        # 搜索结果按 query 缓存：同一句话重复问不重复计费（Search 按成功请求收费）
        ck = cache_key("web_search", [provider, query.strip(), count])
        hit = cache_get("web_search", ck, SEARCH_TTL)
        if hit is not None:
            return {"ok": True, "provider": provider, "results": hit, "cached": True}
        url, headers, payload = build_search_request(provider, key, query, count)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except (TypeError, ValueError):
        return {"ok": False, "error": "参数错误"}
    try:
        data = call_upstream(url, headers, payload, timeout=15)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        return {"ok": False, "error": f"搜索上游返回 {exc.code}：{detail}"}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"ok": False, "error": f"搜索上游连接失败：{exc}"}
    try:
        results = parse_search_response(provider, data)
    except (AttributeError, TypeError):
        return {"ok": False, "error": f"搜索响应格式异常：{json.dumps(data, ensure_ascii=False)[:200]}"}
    if results:
        cache_set("web_search", ck, results)
    return {"ok": True, "provider": provider, "results": results}


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


# OpenStreetMap 公共服务（Nominatim / Overpass）也要限速 + 缓存：
# 它们由志愿者维护，使用条款要求最多 1 次/秒、必须带可识别的 User-Agent。
_FREE_GATE = threading.Lock()
_FREE_LAST_CALL = [0.0]


def free_gate():
    with _FREE_GATE:
        wait = _FREE_LAST_CALL[0] + FREE_MIN_INTERVAL - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _FREE_LAST_CALL[0] = time.monotonic()


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


def _route_segments(route, mode):
    """压平路线 steps，给出「步行 → 乘车 → 步行」这样的换乘组成。

    公交回包的 steps 是数组套数组（每段是一组可选走法），每段带
    vehicle_info.detail：有 detail 的是乘车（地铁/公交），没有的是步行。
    驾车 / 步行 / 骑行回包的 steps 是扁平数组，这里不展开，避免回包过大。
    """
    if mode != "transit":
        return []
    segments = []
    # 每组只取第一个方案；否则同一段路的备选线路会重复出现在时间轴上
    for step in _transit_steps(route):
        vehicle = (step.get("vehicle_info") or {}).get("detail") or {}
        distance = int(step.get("distance") or 0)
        duration = float(step.get("duration") or 0)
        start, end = _lnglat(step.get("start_location")), _lnglat(step.get("end_location"))
        if vehicle:
            name = vehicle.get("name") or "公交/地铁"
            item = {
                "mode": "transit", "name": name,
                "text": step.get("instructions") or name,
                "km": round(distance / 1000.0, 2),
                "min": round(duration / 60.0, 1),
            }
            if vehicle.get("stop_num"):
                item["stops"] = int(vehicle["stop_num"])
            if vehicle.get("on_station"):
                item["fromName"] = vehicle["on_station"]
            if vehicle.get("off_station"):
                item["toName"] = vehicle["off_station"]
        else:
            item = {
                "mode": "walk", "name": "步行",
                "text": step.get("instructions") or f"步行{distance}米",
                "km": round(distance / 1000.0, 2),
                "min": round(duration / 60.0, 1),
            }
        if start:
            item["from"] = [round(start[0], 6), round(start[1], 6)]
        if end:
            item["to"] = [round(end[0], 6), round(end[1], 6)]
        if item["km"] > 0 or item["min"] > 0:
            segments.append(item)
    return segments


def parse_baidu_route(data, mode="driving"):
    """从 direction/v2 响应提取 km / min / 完整折线 path（GCJ-02）。

    path 是所有 step 的折线按顺序拼接、去重后的结果，直接画在图上即为真实道路，
    而不是点到点的直线。公交路线可能还带 price（元）；公交还会额外返回
    segments，用于前端展示「步行 → 地铁/公交 → 步行」的混合组成。
    """
    status = data.get("status")
    if status != 0:
        raise ValueError(f"百度返回 status={status}：{data.get('message', '未知错误')}")
    result = data.get("result") or {}
    routes = result.get("routes") or []
    if not routes:
        raise ValueError("百度未返回可用路线（可能起终点不可达）")
    # 百度可能返回多条备选路线；按耗时取最快，公交/驾车都遵循「时间优先」
    route = _best_transit_route(data) if mode == "transit" else min(
        routes, key=lambda r: (
            float(r["duration"]) if isinstance(r.get("duration"), (int, float)) else 1e18))
    path = []
    if mode == "transit":
        # 每个换乘组只取第一条方案；缺失 path 时退回该段起终点
        for step in _transit_steps(route):
            for pt in _transit_step_points(step):
                if path and abs(path[-1][0] - pt[0]) < 1e-7 and abs(path[-1][1] - pt[1]) < 1e-7:
                    continue
                path.append(pt)
    else:
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
    if mode == "transit":
        segments = _route_segments(route, mode)
        if segments:
            out["segments"] = segments
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
    query = (body.get("query") or "").strip()
    region = (body.get("region") or body.get("city") or "").strip()
    page_size = body.get("pageSize") or 10
    page_num = body.get("pageNum") or 0
    key = cache_key("place", [query, region, page_size, page_num])
    hit = cache_get("places", key, PLACE_TTL)
    if hit is not None:
        return {"ok": True, "places": hit, "cached": True}
    try:
        url = build_baidu_place_url(
            resolve_baidu_ak(headers_in.get("X-Baidu-Ak")),
            query, region, page_size, page_num,
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
    cache_set("places", key, places)
    return {"ok": True, "places": places}


def handle_baidu_suggest(body, headers_in):
    """模糊搜索：返回候选列表，用户点选后再走 /api/baidu/detail 取出入口。"""
    query = body.get("query") or ""
    region = body.get("region") or body.get("city") or ""
    city_limit = body.get("cityLimit")
    city_limit = True if city_limit is None else bool(city_limit)
    key = cache_key("suggest", [query, region, city_limit])
    hit = cache_get("places", key, PLACE_TTL)
    if hit is not None:
        return {"ok": True, "places": hit, "cached": True}
    try:
        url = build_baidu_suggest_url(
            resolve_baidu_ak(headers_in.get("X-Baidu-Ak")),
            query, region, city_limit,
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
    cache_set("places", key, places)
    return {"ok": True, "places": places}


def handle_baidu_detail(body, headers_in):
    uid = body.get("uid") or ""
    key = cache_key("detail", [uid])
    hit = cache_get("places", key, PLACE_TTL)
    if hit is not None:
        return {"ok": True, "place": hit, "cached": True}
    try:
        url = build_baidu_detail_url(
            resolve_baidu_ak(headers_in.get("X-Baidu-Ak")),
            uid,
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
    cache_set("places", key, place)
    return {"ok": True, "place": place}


def _haversine_km(a, b):
    """两个 [lng, lat] 点的大圆距离（km）。"""
    lng1, lat1, lng2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    x = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(x))


# 公交/地铁回包的车辆段只有站点坐标，站间会画成直线；超过这个间距就补一次驾车路网。
# 0.35km 能覆盖绝大多数公交站距（地铁站距约 1–2km，也会补齐）。
TRANSIT_SMOOTH_MIN_GAP_KM = 0.35
TRANSIT_MAX_SMOOTH_CALLS = 10  # 单条公交路线最多补几次，避免换乘多时额度失控


def _best_transit_route(data):
    """按耗时选最快的一条公交方案，解析与平滑必须用同一条。"""
    routes = (data.get("result") or {}).get("routes") or []
    if not routes:
        return None
    return min(routes, key=lambda r: (
        float(r["duration"]) if isinstance(r.get("duration"), (int, float)) else 1e18))


def _transit_steps(route):
    """每个换乘组只取第一个方案。

    百度公交回包的 steps 是「数组套数组」：外层每一组是一段路，内层可能
    有多个备选线路。如果把组内所有备选的 path 都拼进来，路线会走一段
    再倒回去走另一条，地图上就出现大量折返和直线。因此这里每组只取
    第一条（百度的推荐方案）。
    """
    for group in route.get("steps") or []:
        items = group if isinstance(group, list) else [group]
        for step in items:
            if isinstance(step, dict):
                yield step
                break


def _transit_step_points(step):
    """取一段路的折线；百度偶尔只给起终点不给 path，此时用起终点补上。"""
    pts = []
    _append_path(pts, step.get("path"))
    if len(pts) < 2:
        start = _lnglat(step.get("start_location"))
        end = _lnglat(step.get("end_location"))
        if start and end:
            pts = [[start[0], start[1]], [end[0], end[1]]]
    return pts


def _max_path_gap(pts):
    if len(pts) < 2:
        return 0.0
    return max(_haversine_km(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def _driving_path_between(ak, a, b, expected_km):
    """取一段真实道路折线，用于替换公交站间直线；失败或明显绕路时返回 None。"""
    try:
        url = build_baidu_route_url(ak, a, b, "driving")
    except ValueError:
        return None
    data, err = _baidu_request(url)
    if err:
        return None
    try:
        out = parse_baidu_route(data, "driving")
    except ValueError:
        return None
    path = out.get("path") or []
    if len(path) < 2:
        return None
    km = float(out.get("km") or 0)
    # 驾车绕路明显超过公交段长度时宁可不替换，避免画出一条离谱的线
    if expected_km >= 1.0 and (km > max(expected_km * 2.5, expected_km + 8)
                               or km < expected_km * 0.5):
        return None
    return path


def smooth_transit_path(data, ak):
    """把公交/地铁折线补成连续的真实道路线。

    需要处理三种情况：
    1. 车辆段只有稀疏的站点坐标（站间直线）——用驾车路网补；
    2. 某些段百度只给起终点、没有 path——同样用起终点补；
    3. 相邻两段的端点对不上，拼接处出现跳线——在缺口处补一小段。
    补出来的路线随整条公交路线一起缓存，同一条路线只会多花一次配额。
    没有可补的段时返回 None，调用方保留原折线。
    """
    route = _best_transit_route(data)
    if not route:
        return None
    calls = 0
    changed = False

    def drive(a, b, expected_km):
        nonlocal calls
        if calls >= TRANSIT_MAX_SMOOTH_CALLS:
            return None
        calls += 1
        return _driving_path_between(ak, a, b, expected_km)

    step_paths = []
    for step in _transit_steps(route):
        pts = _transit_step_points(step)
        if not pts:
            continue
        if _max_path_gap(pts) > TRANSIT_SMOOTH_MIN_GAP_KM:
            expected = float(step.get("distance") or 0) / 1000.0
            if expected <= 0:
                expected = _haversine_km(pts[0], pts[-1])
            driven = drive(pts[0], pts[-1], expected)
            if driven:
                pts = driven
                changed = True
        step_paths.append(pts)

    merged = []

    def append_points(points):
        for p in points:
            if merged and abs(merged[-1][0] - p[0]) < 1e-7 and abs(merged[-1][1] - p[1]) < 1e-7:
                continue
            merged.append(p)

    for pts in step_paths:
        if merged:
            gap = _haversine_km(merged[-1], pts[0])
            if gap > TRANSIT_SMOOTH_MIN_GAP_KM:
                driven = drive(merged[-1], pts[0], gap)
                if driven:
                    append_points(driven[1:])
                    changed = True
        append_points(pts)
    if not changed:
        return None
    return _thin_path(merged)


def handle_baidu_route(body, headers_in):
    mode = body.get("mode") or "driving"
    from_pt = body.get("from") or []
    to_pt = body.get("to") or []
    key = cache_key("route", [
        ROUTE_CACHE_VERSION, point_key(from_pt), point_key(to_pt), mode,
        body.get("city1") or "", body.get("city2") or "",
    ])
    force = bool(body.get("force"))
    if not force:
        hit = cache_get("routes", key, ROUTE_TTL)
        if hit is not None:
            return {"ok": True, **hit, "cached": True}
    ak = resolve_baidu_ak(headers_in.get("X-Baidu-Ak"))
    try:
        url = build_baidu_route_url(
            ak, from_pt, to_pt, mode,
            body.get("city1"), body.get("city2"),
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    data, err = _baidu_request(url)
    if err:
        return {"ok": False, "error": err}
    try:
        out = parse_baidu_route(data, mode)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    # 公交车辆段补真实道路；失败不影响主路线
    if mode == "transit" and body.get("smooth", True):
        smoothed = smooth_transit_path(data, ak)
        if smoothed:
            out["path"] = smoothed
            out["smoothed"] = True
    cache_set("routes", key, out)
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


# ================= 高德地图开放平台（Web 服务 API） =================
# 与百度适配层同构：入参同样是 [lng, lat]（GCJ-02，高德原生坐标系），
# 出参同样是 {ok, mode, km, min, path} / {ok, places}，所以上层 /api/map/*
# 可以无差别切换两家，把配额压力摊开。

AMAP_BASE = "https://restapi.amap.com"
AMAP_ROUTE_URLS = {
    "driving": f"{AMAP_BASE}/v3/direction/driving",
    "walking": f"{AMAP_BASE}/v3/direction/walking",
    "riding": f"{AMAP_BASE}/v4/direction/bicycling",
    "transit": f"{AMAP_BASE}/v3/direction/transit/integrated",
}
AMAP_PLACE_URL = f"{AMAP_BASE}/v3/place/text"
AMAP_REVERSE_URL = f"{AMAP_BASE}/v3/geocode/regeo"

# 高德 Web 服务个人配额通常 3 次/秒；默认留余量，可用 AMAP_MIN_INTERVAL 调整。
AMAP_MIN_INTERVAL = float(os.environ.get("AMAP_MIN_INTERVAL", "0.34"))
_AMAP_GATE = threading.Lock()
_AMAP_LAST_CALL = [0.0]


def amap_gate():
    """高德侧全局节流：相邻上游调用间隔 ≥ AMAP_MIN_INTERVAL，并发请求在此排队。"""
    with _AMAP_GATE:
        wait = _AMAP_LAST_CALL[0] + AMAP_MIN_INTERVAL - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _AMAP_LAST_CALL[0] = time.monotonic()


def resolve_amap_key(header_key=None):
    return header_key or os.environ.get("AMAP_MAP_KEY")


def amap_ready():
    return bool(os.environ.get("AMAP_MAP_KEY"))


def amap_browser_key():
    return os.environ.get("AMAP_BROWSER_KEY", "")


def amap_config():
    return {
        "ready": amap_ready(),
        "host": "restapi.amap.com",
        "browserAK": amap_browser_key(),
        "minInterval": int(AMAP_MIN_INTERVAL * 1000),
    }


def _amap_lnglat(pair):
    """[lng, lat] -> 'lng,lat'。高德与页面同为 GCJ-02 且都是经度在前，不需要换序。"""
    if not isinstance(pair, (list, tuple)) or len(pair) != 2:
        raise ValueError("from / to 需为 [经度, 纬度] 二元组")
    return f"{_coord(pair[0])},{_coord(pair[1])}"


def build_amap_route_url(key, from_pair, to_pair, mode="driving", city1=None):
    if not key:
        raise ValueError("未找到高德 key：请设置环境变量 AMAP_MAP_KEY 或在设置面板填写")
    base = AMAP_ROUTE_URLS.get(mode)
    if not base:
        raise ValueError(f"高德暂不支持 {mode} 模式")
    params = {
        "origin": _amap_lnglat(from_pair),
        "destination": _amap_lnglat(to_pair),
        "key": key,
    }
    if mode == "transit":
        # 高德公交必须给城市，否则直接返回 INVALID_PARAMS
        params["city"] = city1 or "全国"
        params["cityd"] = city1 or "全国"
    return base + "?" + urllib.parse.urlencode(params)


def _amap_ok(data):
    if str(data.get("status")) != "1":
        raise ValueError(f"高德返回 status={data.get('status')}：{data.get('info') or '未知错误'}")


def _amap_polyline(text):
    """'lng,lat;lng,lat' -> [[lng,lat], ...]（丢弃脏点）"""
    pts = []
    for chunk in (text or "").split(";"):
        if "," not in chunk:
            continue
        a, b = chunk.split(",", 1)
        try:
            pts.append([round(float(a), 6), round(float(b), 6)])
        except ValueError:
            continue
    return pts


def parse_amap_route(data, mode="driving"):
    """高德 v3（driving/walking/transit）与 v4（bicycling）统一成百度同款出参。

    骑行 v4 的响应结构是 data.paths，且用车牌判断 errcode；其余为 route.paths。
    """
    if mode == "riding":
        code = data.get("errcode")
        if str(code) not in ("0", "None"):
            raise ValueError(f"高德骑行返回 errcode={code}：{data.get('errmsg', '')}")
        paths = (data.get("data") or {}).get("paths") or []
    else:
        _amap_ok(data)
        route = data.get("route") or {}
        paths = route.get("transits") if mode == "transit" else route.get("paths")
        paths = paths or []
    if not paths:
        raise ValueError("高德未返回可用路线（可能起终点不可达）")
    best = min(paths, key=lambda p: float(p.get("duration") or 1e18))
    path = []
    if mode == "transit":
        for seg in best.get("segments") or []:
            for st in ((seg.get("walking") or {}).get("steps") or []):
                path += _amap_polyline(st.get("polyline"))
            for line in ((seg.get("bus") or {}).get("buslines") or []):
                path += _amap_polyline(line.get("polyline"))
    else:
        for st in best.get("steps") or []:
            path += _amap_polyline(st.get("polyline"))
    out = {
        "mode": mode,
        "km": round(float(best.get("distance") or 0) / 1000.0, 2),
        "min": round(float(best.get("duration") or 0) / 60.0, 1),
        "path": _thin_path(path),
    }
    if best.get("tolls") not in (None, "", []):
        try:
            out["cost"] = float(best["tolls"])
        except (TypeError, ValueError):
            pass
    return out


def build_amap_place_url(key, query, region=None, page_size=10, page=1):
    if not key:
        raise ValueError("未找到高德 key：请设置环境变量 AMAP_MAP_KEY 或在设置面板填写")
    if not query:
        raise ValueError("query 必填")
    params = {
        "keywords": query,
        "key": key,
        "offset": max(1, min(int(page_size), 25)),
        "page": max(1, int(page)),
        "extensions": "base",
    }
    if region:
        params["city"] = region
    return AMAP_PLACE_URL + "?" + urllib.parse.urlencode(params)


def parse_amap_place(data):
    """高德 poi 与百度 place 统一结构。

    高德没有 navi_location，所以 hasNav=False、导航点回退到地址坐标；
    前端拿到 hasNav=False 会按景点中心走，不影响可用性。
    """
    _amap_ok(data)
    places = []
    for item in data.get("pois") or []:
        loc = _lnglat(item.get("location"))
        if not loc:
            continue
        addr = item.get("address")
        if isinstance(addr, list):
            addr = "".join(addr)
        tel = item.get("tel")
        places.append({
            "name": item.get("name") or "",
            "address": addr or "",
            "lng": loc[0], "lat": loc[1],
            "navLng": loc[0], "navLat": loc[1],
            "hasNav": False,
            "tag": item.get("type") or "",
            "uid": f"amap:{item.get('id')}" if item.get("id") else "",
            "tel": tel if isinstance(tel, str) else "",
        })
    return places


def _amap_request(url, timeout=15):
    """调用高德 Web 服务：全局节流 + 统一错误文案，返回 (data, error)。"""
    amap_gate()
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        return None, f"高德返回 {exc.code}：{detail}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return None, f"高德连接失败：{exc}"
    except json.JSONDecodeError:
        return None, "高德响应不是合法 JSON"


def handle_amap_route(body, headers_in):
    mode = body.get("mode") or "driving"
    from_pt = body.get("from") or []
    to_pt = body.get("to") or []
    # 与百度共用 routes 分区，但键带 amap 前缀，两家互不覆盖
    key = cache_key("amap_route", [
        ROUTE_CACHE_VERSION, point_key(from_pt), point_key(to_pt), mode,
        body.get("city1") or "",
    ])
    if not body.get("force"):
        hit = cache_get("routes", key, ROUTE_TTL)
        if hit is not None:
            return {"ok": True, **hit, "cached": True}
    try:
        url = build_amap_route_url(
            resolve_amap_key(headers_in.get("X-Amap-Key")),
            from_pt, to_pt, mode, body.get("city1"),
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    data, err = _amap_request(url)
    if err:
        return {"ok": False, "error": err}
    try:
        out = parse_amap_route(data, mode)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    cache_set("routes", key, out)
    return {"ok": True, **out}


def handle_amap_place(body, headers_in):
    query = (body.get("query") or "").strip()
    region = (body.get("region") or "").strip()
    page_size = body.get("pageSize") or 10
    key = cache_key("amap_place", [query, region, page_size])
    hit = cache_get("places", key, PLACE_TTL)
    if hit is not None:
        return {"ok": True, "source": "amap", "places": hit, "cached": True}
    try:
        url = build_amap_place_url(
            resolve_amap_key(headers_in.get("X-Amap-Key")),
            query, region, page_size,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    data, err = _amap_request(url)
    if err:
        return {"ok": False, "error": err}
    try:
        places = parse_amap_place(data)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    if places:  # 空结果不写缓存，避免一次失败把查询永久钉死
        cache_set("places", key, places)
    return {"ok": True, "source": "amap", "places": places}


# ================= 双供应商路由（分摊配额 + 自动降级） =================
# 两家都配了 key 时，不同能力默认落到不同供应商：
#   - 路线规划量大且要折线，默认先百度，失败切高德；
#   - POI 检索量大但轻，默认先高德，失败切百度。
# 这样单家的 QPS 压力直接被摊薄一半，任何一家挂了也不影响页面。

ROUTE_PROVIDER_ORDER = ("baidu", "amap")
PLACE_PROVIDER_ORDER = ("amap", "baidu")
_ALT_LOCK = threading.Lock()
_ALT_STATE = [0]


def map_config():
    return {
        "default": os.environ.get("MAP_PROVIDER", "auto"),
        "providers": {
            "baidu": {"label": "百度地图", **baidu_config()},
            "amap": {"label": "高德地图", **amap_config()},
        },
        "capabilities": {
            "route": list(ROUTE_PROVIDER_ORDER),
            "place": list(PLACE_PROVIDER_ORDER),
        },
    }


def _provider_available(name, headers_in):
    if name == "baidu":
        return bool(headers_in.get("X-Baidu-Ak") or baidu_ready())
    return bool(headers_in.get("X-Amap-Key") or amap_ready())


def _pick_providers(kind, requested, headers_in):
    """返回候选顺序：显式指定则先它后另一家；auto 则按能力默认顺序轮换起点。"""
    base = ROUTE_PROVIDER_ORDER if kind == "route" else PLACE_PROVIDER_ORDER
    if requested in ("baidu", "amap"):
        other = "amap" if requested == "baidu" else "baidu"
        order = [requested, other]
    elif requested == "auto":
        with _ALT_LOCK:
            flip = _ALT_STATE[0] % 2
            _ALT_STATE[0] += 1
        order = list(base[flip:] + base[:flip])
    else:
        order = list(base)
    return [name for name in order if _provider_available(name, headers_in)] or list(base[:1])


def handle_map_route(body, headers_in):
    """统一入口：先查"任意供应商"的结果缓存，再按候选顺序请求。

    自动模式会在两家之间轮换，如果只按供应商缓存，同样的两点换个供应商就又会
    打一次上游。这里再加一层不带供应商的键，谁先算出来谁的结果都能被复用。
    """
    mode = body.get("mode") or "driving"
    key = cache_key("map_route", [
        ROUTE_CACHE_VERSION, point_key(body.get("from") or []),
        point_key(body.get("to") or []), mode,
        body.get("city1") or "", body.get("city2") or "",
    ])
    if not body.get("force"):
        hit = cache_get("routes", key, ROUTE_TTL)
        if hit is not None:
            return {"ok": True, **hit, "cached": True}

    errors = []
    for name in _pick_providers("route", body.get("provider"), headers_in):
        handler = handle_baidu_route if name == "baidu" else handle_amap_route
        out = handler(body, headers_in)
        if out.get("ok"):
            out["provider"] = name
            payload = {k: v for k, v in out.items() if k not in ("cached",)}
            cache_set("routes", key, payload)
            return out
        errors.append(f"{name}: {out.get('error', '失败')}")
    return {"ok": False, "error": "；".join(errors) or "没有可用的地图服务"}


def handle_map_place(body, headers_in):
    key = cache_key("map_place", [
        (body.get("query") or "").strip(),
        (body.get("region") or "").strip(),
        body.get("pageSize") or 10,
    ])
    hit = cache_get("places", key, PLACE_TTL)
    if hit is not None:
        return {"ok": True, **hit, "cached": True}

    errors = []
    for name in _pick_providers("place", body.get("provider"), headers_in):
        handler = handle_baidu_place if name == "baidu" else handle_amap_place
        out = handler(body, headers_in)
        if out.get("ok") and out.get("places"):
            out["provider"] = name
            payload = {k: v for k, v in out.items() if k not in ("cached",)}
            cache_set("places", key, payload)
            return out
        errors.append(f"{name}: {out.get('error') or '无结果'}")
    return {"ok": False, "error": "；".join(errors) or "没有可用的地图服务", "places": []}


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
        "User-Agent": "Mozilla/5.0 (compatible; itinerary-engine/1.0)",
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


# ================= 免费火车站数据（12306 车站库，不占百度配额） =================
RAIL_STATION_URL = "https://kyfw.12306.cn/otn/resources/js/framework/station_name.js"
RAIL_CACHE_FILE = CACHE_DIR / "rail_stations.json"
RAIL_CACHE_TTL = 7 * 86400
_RAIL_LOCK = threading.Lock()
_RAIL_STATIONS = None
_RAIL_RETRY_AT = 0        # 12306 暂时不可用时的退避时间，避免每次搜索都等超时


def parse_12306_stations(raw):
    """解析 12306 station_name.js：abbr|中文名|电报码|拼音|简拼|序号|...|城市。"""
    start = raw.find("='")
    end = raw.rfind("'")
    if start < 0 or end <= start:
        raise ValueError("12306 车站库格式异常")
    body = raw[start + 2:end]
    out = []
    for row in body.split("@"):
        fields = row.split("|")
        if len(fields) < 8 or not fields[1]:
            continue
        out.append({
            "name": fields[1],
            "pinyin": fields[3],
            "abbr": fields[4],
            "code": fields[2],
            "city": fields[7] or fields[1],
        })
    if not out:
        raise ValueError("12306 车站库为空")
    return out


def _load_rail_cache():
    try:
        data = json.loads(RAIL_CACHE_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("stations"), list):
            return data
    except (OSError, ValueError):
        pass
    return None


def load_rail_stations():
    """12306 全国车站列表：本机缓存 7 天，过期后后台刷新失败也会继续用旧数据。"""
    global _RAIL_STATIONS, _RAIL_RETRY_AT
    with _RAIL_LOCK:
        if _RAIL_STATIONS is not None:
            return _RAIL_STATIONS
        cached = _load_rail_cache()
        now = time.time()
        if cached and now - float(cached.get("t") or 0) < RAIL_CACHE_TTL:
            _RAIL_STATIONS = cached["stations"]
            return _RAIL_STATIONS
        stale = (cached or {}).get("stations") or []
        if now < _RAIL_RETRY_AT:
            return stale
        try:
            req = urllib.request.Request(RAIL_STATION_URL, headers={
                "User-Agent": ("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 "
                               "(KHTML, like Gecko) Chrome/120 Mobile Safari/537.36"),
                "Referer": "https://kyfw.12306.cn/otn/leftTicket/init",
            })
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            stations = parse_12306_stations(raw)
            _RAIL_STATIONS = stations
            try:
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                RAIL_CACHE_FILE.write_text(
                    json.dumps({"t": now, "stations": stations}, ensure_ascii=False),
                    encoding="utf-8",
                )
            except OSError:
                pass
            return stations
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            _RAIL_RETRY_AT = now + 300  # 5 分钟后再试；期间用旧缓存 / 内置数据
            return stale


def filter_rail_stations(stations, city="", query="", limit=30):
    """按城市 + 关键词筛选，中文 / 拼音 / 简拼都能命中；同城主站排前面。"""
    city = (city or "").strip()
    needle = (query or "").strip().lower()
    rows = []
    for s in stations:
        scity = s.get("city") or ""
        if city and not (scity == city or scity.startswith(city) or city.startswith(scity)):
            continue
        if needle:
            hay = " ".join([
                s.get("name") or "", s.get("pinyin") or "",
                s.get("abbr") or "", scity,
            ]).lower()
            if needle not in hay:
                continue
        # 同城同名站（如「北京」）优先，其次名称以关键词 / 城市开头
        score = 0
        name = s.get("name") or ""
        if needle and name.lower() == needle:
            score -= 30
        elif needle and name.startswith(query.strip()):
            score -= 10
        if city and name == city:
            score -= 20
        elif city and name.startswith(city):
            score -= 5
        score += len(name)
        rows.append((score, s))
    rows.sort(key=lambda x: x[0])
    return [s for _, s in rows[:max(1, min(int(limit or 30), 100))]]


def handle_rail_stations(query_string):
    params = urllib.parse.parse_qs(query_string or "")
    city = (params.get("city") or [""])[0]
    query = (params.get("q") or [""])[0]
    try:
        limit = int((params.get("limit") or ["30"])[0])
    except ValueError:
        limit = 30
    stations = load_rail_stations()
    if not stations:
        return {"ok": False, "error": "12306 车站数据暂时不可用", "stations": []}
    return {
        "ok": True,
        "source": "12306",
        "total": len(stations),
        "stations": filter_rail_stations(stations, city, query, limit),
    }


# ================= 免费地点数据（OpenStreetMap，不占百度配额） =================
# 火车：12306 官方车站库（上面的 /api/rail-stations）。
# 地点：Nominatim 免费地理编码，适合酒店 / 出发点 / 机场等模糊搜索。
# 景点：Overpass 免费查询城市周边 tourism / historic 要素，补齐未深度收录城市。
# 两者都带持久缓存和 1 次/秒闸门，避免给志愿者服务造成压力。

FREE_UA = "itinerary-engine/0.1 (local demo; free-data fallback)"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
_GCJ_A = 6378245.0
_GCJ_EE = 0.00669342162296594323


def _out_of_china(lng, lat):
    return not (72.004 <= lng <= 137.8347 and 0.8293 <= lat <= 55.8271)


def _gcj_transform_lat(x, y):
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320.0 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _gcj_transform_lng(x, y):
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lng, lat):
    """WGS-84（OSM）→ GCJ-02（百度 / 高德底图），否则会在国内偏移几百米。"""
    if _out_of_china(lng, lat):
        return [lng, lat]
    dlat = _gcj_transform_lat(lng - 105.0, lat - 35.0)
    dlng = _gcj_transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = 1 - _GCJ_EE * math.sin(radlat) ** 2
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_GCJ_A * (1 - _GCJ_EE)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (_GCJ_A / sqrtmagic * math.cos(radlat) * math.pi)
    return [lng + dlng, lat + dlat]


def _free_get_json(url, timeout=25):
    free_gate()
    req = urllib.request.Request(url, headers={
        "User-Agent": FREE_UA,
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _free_place_name(item):
    addr = item.get("address") or {}
    for key in ("name", "tourism", "amenity", "aeroway", "railway", "shop", "building"):
        if addr.get(key):
            return str(addr[key]).strip()
    display = str(item.get("display_name") or "")
    return display.split(",")[0].strip()


def _free_place_tag(item):
    cls = (item.get("class") or "").lower()
    typ = (item.get("type") or "").lower()
    if cls == "aeroway" or "airport" in typ or typ == "aerodrome":
        return "机场"
    if cls == "railway" or typ in ("station", "halt", "train_station"):
        return "车站"
    # 住宿类型要先于 tourism 大类判断：Nominatim 的酒店多为 tourism/hotel
    if cls in ("hotel", "guest_house", "hostel") or typ in (
            "hotel", "guest_house", "hostel", "apartment", "motel"):
        return "酒店"
    if cls in ("tourism", "historic"):
        return "景点"
    return ""


def parse_nominatim_places(data, limit=8):
    """把 Nominatim 结果整理成页面统一的地点结构（坐标已转 GCJ-02）。"""
    rows = data if isinstance(data, list) else []
    out, seen = [], set()
    for item in rows:
        if not isinstance(item, dict):
            continue
        try:
            lat, lng = float(item.get("lat")), float(item.get("lon"))
        except (TypeError, ValueError):
            continue
        name = _free_place_name(item)
        if not name or name in seen:
            continue
        pt = wgs84_to_gcj02(lng, lat)
        out.append({
            "name": name[:80],
            "address": str(item.get("display_name") or "")[:160],
            "lng": round(pt[0], 6),
            "lat": round(pt[1], 6),
            "tag": _free_place_tag(item),
            "source": "OpenStreetMap",
        })
        seen.add(name)
        if len(out) >= limit:
            break
    return out


def build_overpass_attractions_query(lat, lng, radius=30000):
    return (
        f"[out:json][timeout:25];\n"
        f"(\n"
        f'  nwr["tourism"~"attraction|museum|viewpoint|zoo|theme_park"]'
        f"(around:{int(radius)},{lat:.6f},{lng:.6f});\n"
        f'  nwr["historic"~"memorial|monument|castle|ruins"]'
        f"(around:{int(radius)},{lat:.6f},{lng:.6f});\n"
        f");\n"
        f"out center 60;"
    )


def parse_overpass_places(data, limit=30, center=None):
    """解析 Overpass 要素；按距市中心距离排序，坐标转 GCJ-02。"""
    elements = (data.get("elements") if isinstance(data, dict) else None) or []
    out, seen = [], set()
    for el in elements:
        if not isinstance(el, dict):
            continue
        tags = el.get("tags") or {}
        name = tags.get("name:zh") or tags.get("name") or tags.get("name:en")
        if not name:
            continue
        lat, lng = el.get("lat"), el.get("lon")
        if lat is None or lng is None:
            center_pt = el.get("center") or {}
            lat, lng = center_pt.get("lat"), center_pt.get("lon")
        try:
            lat, lng = float(lat), float(lng)
        except (TypeError, ValueError):
            continue
        name = str(name).strip()
        if not name or name in seen:
            continue
        pt = wgs84_to_gcj02(lng, lat)
        kind = tags.get("tourism") or tags.get("historic") or "attraction"
        out.append({
            "id": f"osm-{el.get('type', 'n')}-{el.get('id', '')}",
            "name": name[:80],
            "lng": round(pt[0], 6),
            "lat": round(pt[1], 6),
            "tier": "explore",
            "ticket": 0,
            "suggest_min": 90,
            "satisfaction": 0.6,
            "note": f"OpenStreetMap · {kind}",
            "source": "OpenStreetMap",
        })
        seen.add(name)
    if center and len(center) == 2:
        out.sort(key=lambda p: _haversine_km(center, [p["lng"], p["lat"]]))
    return out[:limit]


def handle_free_places(query_string):
    params = urllib.parse.parse_qs(query_string or "")
    q = (params.get("q") or [""])[0].strip()
    city = (params.get("city") or [""])[0].strip()
    try:
        limit = int((params.get("limit") or ["8"])[0])
    except ValueError:
        limit = 8
    limit = max(1, min(limit, 15))
    if not q:
        return {"ok": False, "error": "缺少 q 参数", "places": []}
    key = cache_key("free_place", [q, city, limit])
    hit = cache_get("free_places", key, FREE_PLACE_TTL)
    if hit is not None:
        return {"ok": True, "source": "OpenStreetMap/Nominatim", "places": hit, "cached": True}
    text = q if (not city or city in q) else f"{q}, {city}"
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({
        "q": text, "format": "jsonv2", "addressdetails": "1", "limit": limit,
        # 含港澳（页面城市库覆盖港澳）；Nominatim 的 countrycodes 支持逗号分隔
        "accept-language": "zh-CN", "countrycodes": "cn,hk,mo", "dedupe": "1",
    })
    try:
        places = parse_nominatim_places(_free_get_json(url), limit)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        return {"ok": False, "error": f"OpenStreetMap 地点搜索暂不可用：{exc}", "places": []}
    if places:
        cache_set("free_places", key, places)
    return {"ok": True, "source": "OpenStreetMap/Nominatim", "places": places}


def handle_free_attractions(query_string):
    params = urllib.parse.parse_qs(query_string or "")
    try:
        lat = float((params.get("lat") or [""])[0])
        lng = float((params.get("lng") or [""])[0])
    except ValueError:
        return {"ok": False, "error": "缺少有效的 lat / lng 参数", "places": []}
    try:
        limit = int((params.get("limit") or ["30"])[0])
    except ValueError:
        limit = 30
    limit = max(1, min(limit, 40))
    key = cache_key("free_poi", [round(lat, 3), round(lng, 3), limit])
    hit = cache_get("free_pois", key, FREE_POI_TTL)
    if hit is not None:
        return {"ok": True, "source": "OpenStreetMap/Overpass", "places": hit, "cached": True}
    query = build_overpass_attractions_query(lat, lng)
    data, last_err = None, None
    for base in OVERPASS_URLS:
        try:
            data = _free_get_json(base + "?" + urllib.parse.urlencode({"data": query}), timeout=30)
            break
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            last_err = exc
    if data is None:
        return {
            "ok": False,
            "error": f"OpenStreetMap 景点数据暂不可用：{last_err}",
            "places": [],
        }
    places = parse_overpass_places(data, limit, center=[lng, lat])
    if places:
        cache_set("free_pois", key, places)
    return {"ok": True, "source": "OpenStreetMap/Overpass", "places": places}


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
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
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
        if path == "/api/amap-config":
            return self._send(amap_config())
        if path == "/api/map/config":
            return self._send(map_config())
        if path == "/api/rail-stations":
            return self._send(handle_rail_stations(parsed_url.query))
        if path == "/api/free/places":
            return self._send(handle_free_places(parsed_url.query))
        if path == "/api/free/attractions":
            return self._send(handle_free_attractions(parsed_url.query))
        if path == "/api/cache/config":
            return self._send(handle_cache_config())
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
            # errors="replace"：浏览器恒为 UTF-8；编码错误的 CLI 测试也不会 500
            body = json.loads(self.rfile.read(n).decode("utf-8", errors="replace") or "{}")
            path = self.path.split("?")[0]
            if path == "/api/llm":
                return self._send(handle_llm(body, self.headers))
            if path == "/api/llm/models":
                return self._send(handle_llm_models(body, self.headers))
            if path == "/api/web-search":
                return self._send(handle_web_search(body, self.headers))
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
            if path == "/api/amap/route":
                return self._send(handle_amap_route(body, self.headers))
            if path == "/api/amap/place":
                return self._send(handle_amap_place(body, self.headers))
            if path == "/api/map/route":
                return self._send(handle_map_route(body, self.headers))
            if path == "/api/map/place":
                return self._send(handle_map_place(body, self.headers))
            if path == "/api/cache/config":
                return self._send(handle_cache_config(body))
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
