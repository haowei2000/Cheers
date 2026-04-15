"""Web tools for bot capabilities: web_fetch and web_search.

Supported search engines (via WEB_SEARCH_ENGINE env):
  - bing_cn  : cn.bing.com (default, accessible in mainland China)
  - baidu    : www.baidu.com
  - duckduckgo : DuckDuckGo (requires duckduckgo_search package)
"""

import json
import logging
from urllib.parse import quote_plus, urlparse

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger("app.tools.web")

# Default content length limits to prevent token overflow
MAX_CONTENT_LENGTH = 15000
MAX_SEARCH_RESULTS = 5
REQUEST_TIMEOUT = 30.0

# User agent — mimic a normal browser to avoid bot-blocking
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)
# Lightweight UA for web_fetch (non-search pages)
USER_AGENT = "AgentNexusBot/1.0 (Research Assistant)"


def _get_settings():
    from app.config import settings
    return settings


# ── URL validation ────────────────────────────────────────────────────────────


def _is_valid_url(url: str) -> bool:
    """Validate that URL has valid scheme and netloc."""
    try:
        parsed = urlparse(url)
        return bool(parsed.scheme in ("http", "https") and parsed.netloc)
    except Exception:
        return False


# ── HTML text extraction ──────────────────────────────────────────────────────


def _extract_text_from_html(html: str, max_length: int = MAX_CONTENT_LENGTH) -> str:
    """Extract readable text from HTML content."""
    soup = BeautifulSoup(html, "html.parser")

    # Remove script, style, nav, footer, and other non-content elements
    for element in soup.find_all(["script", "style", "nav", "footer", "header", "aside", "noscript"]):
        element.decompose()

    # Try to find main content area
    main_content = None
    for selector in ["main", "article", "[role='main']", ".content", ".post", ".entry"]:
        main_content = soup.select_one(selector)
        if main_content:
            break

    if main_content:
        text = main_content.get_text(separator="\n", strip=True)
    else:
        body = soup.find("body")
        if body:
            text = body.get_text(separator="\n", strip=True)
        else:
            text = soup.get_text(separator="\n", strip=True)

    lines = [line.strip() for line in text.split("\n") if line.strip()]
    text = "\n".join(lines)

    if len(text) > max_length:
        text = text[:max_length] + f"\n\n[Content truncated at {max_length} characters]"

    return text


# ── web_fetch ─────────────────────────────────────────────────────────────────


async def web_fetch(url: str, max_length: int = MAX_CONTENT_LENGTH) -> str:
    """Fetch and extract text content from a URL."""
    url = url.strip()
    if not _is_valid_url(url):
        return f"错误：无效的 URL '{url}'。请提供有效的 http:// 或 https:// 链接。"

    try:
        proxy = _get_settings().web_search_proxy or None
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True, proxy=proxy) as client:
            headers = {
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Accept-Encoding": "identity",
            }
            response = await client.get(url, headers=headers)
            response.raise_for_status()

        content_type = response.headers.get("content-type", "").lower()

        if "text/html" in content_type:
            text = _extract_text_from_html(response.text, max_length)
            title = ""
            soup = BeautifulSoup(response.text, "html.parser")
            if soup.title and soup.title.string:
                title = soup.title.string.strip()

            result_parts = []
            if title:
                result_parts.append(f"标题: {title}")
            result_parts.append(f"URL: {url}")
            result_parts.append("---")
            result_parts.append(text)
            return "\n".join(result_parts)

        elif "application/json" in content_type:
            try:
                data = response.json()
                json_text = json.dumps(data, ensure_ascii=False, indent=2)
                if len(json_text) > max_length:
                    json_text = json_text[:max_length] + "\n\n[JSON truncated...]"
                return f"URL: {url}\n类型: JSON\n---\n{json_text}"
            except json.JSONDecodeError:
                return f"URL: {url}\n---\n{response.text[:max_length]}"

        else:
            text = response.text[:max_length]
            if len(response.text) > max_length:
                text += "\n\n[Content truncated...]"
            return f"URL: {url}\n类型: {content_type or 'text'}\n---\n{text}"

    except httpx.TimeoutException:
        logger.warning("web_fetch timeout for URL: %s", url)
        return f"错误：请求超时 ({REQUEST_TIMEOUT}s)。请稍后重试或使用其他链接。"
    except httpx.HTTPStatusError as e:
        logger.warning("web_fetch HTTP error for URL %s: %s", url, e.response.status_code)
        return f"错误：HTTP {e.response.status_code} - 无法访问该页面。"
    except httpx.RequestError as e:
        logger.warning("web_fetch request error for URL %s: %s", url, e)
        return "错误：无法连接到服务器。请检查 URL 是否正确或稍后重试。"
    except Exception as e:
        logger.exception("web_fetch unexpected error for URL %s", url)
        return f"错误：获取页面时发生错误 - {type(e).__name__}"


# ── Search engine backends ────────────────────────────────────────────────────


def _build_http_client(proxy: str | None = None) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT,
        follow_redirects=True,
        proxy=proxy,
        headers={
            "User-Agent": _BROWSER_UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )


async def _search_bing_cn(query: str, num_results: int, proxy: str | None) -> list[dict]:
    """Search via cn.bing.com (国内可直连)."""
    url = f"https://cn.bing.com/search?q={quote_plus(query)}&count={num_results}"
    async with _build_http_client(proxy) as client:
        resp = await client.get(url)
        resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    results: list[dict] = []

    for item in soup.select("li.b_algo"):
        link_tag = item.select_one("h2 a")
        if not link_tag:
            continue
        title = link_tag.get_text(strip=True)
        href = link_tag.get("href", "")
        if not href or not href.startswith("http"):
            continue

        snippet = ""
        # Bing puts snippet in .b_caption p or div.b_caption p
        cap = item.select_one(".b_caption p")
        if cap:
            snippet = cap.get_text(strip=True)
        if not snippet:
            cap = item.select_one("p")
            if cap:
                snippet = cap.get_text(strip=True)

        results.append({"title": title, "url": href, "snippet": snippet})
        if len(results) >= num_results:
            break

    return results


async def _search_baidu(query: str, num_results: int, proxy: str | None) -> list[dict]:
    """Search via www.baidu.com."""
    url = f"https://www.baidu.com/s?wd={quote_plus(query)}&rn={num_results}"
    async with _build_http_client(proxy) as client:
        resp = await client.get(url)
        resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    results: list[dict] = []

    # Baidu organic results: div.result or div.c-container with data-click
    for item in soup.select("div.result, div.c-container"):
        link_tag = item.select_one("h3 a")
        if not link_tag:
            continue
        title = link_tag.get_text(strip=True)
        href = link_tag.get("href", "")
        if not href:
            continue

        snippet = ""
        # Baidu snippet: span.content-right_8Zs40 or div.c-abstract or the first <span> with enough text
        for sel in [".content-right_8Zs40", "div.c-abstract", ".c-span-last span", "span.content-right_8Zs40"]:
            cap = item.select_one(sel)
            if cap:
                snippet = cap.get_text(strip=True)
                break
        if not snippet:
            # fallback: grab the longest text block that's not the title
            for tag in item.find_all(["span", "p", "div"]):
                text = tag.get_text(strip=True)
                if len(text) > len(snippet) and text != title:
                    snippet = text

        # Baidu uses redirect URLs; try to resolve real URL from mu attribute
        real_url = item.get("mu") or href
        results.append({"title": title, "url": real_url, "snippet": snippet[:300]})
        if len(results) >= num_results:
            break

    return results


async def _search_duckduckgo(query: str, num_results: int, proxy: str | None) -> list[dict]:
    """Search via DuckDuckGo (requires duckduckgo_search package)."""
    from duckduckgo_search import DDGS

    results = []
    with DDGS(proxy=proxy) as ddgs:
        search_results = ddgs.text(query, max_results=num_results)
        for result in search_results:
            results.append({
                "title": result.get("title", ""),
                "url": result.get("href", ""),
                "snippet": result.get("body", ""),
            })
    return results


# Engine registry
_SEARCH_ENGINES = {
    "bing_cn": _search_bing_cn,
    "baidu": _search_baidu,
    "duckduckgo": _search_duckduckgo,
}


# ── Public API ────────────────────────────────────────────────────────────────


async def web_search(query: str, num_results: int = MAX_SEARCH_RESULTS) -> list[dict]:
    """Search the web using configured search engine.

    Engine is selected via WEB_SEARCH_ENGINE env (default: bing_cn).
    Supports: bing_cn, baidu, duckduckgo.
    """
    try:
        num_results = int(num_results)
    except (TypeError, ValueError):
        num_results = MAX_SEARCH_RESULTS
    num_results = max(1, min(10, num_results))

    query = query.strip()
    if not query:
        return []

    cfg = _get_settings()
    engine_name = (cfg.web_search_engine or "bing_cn").lower().strip()
    proxy = cfg.web_search_proxy or None
    engine_fn = _SEARCH_ENGINES.get(engine_name)
    if engine_fn is None:
        logger.error("web_search: unknown engine '%s', falling back to bing_cn", engine_name)
        engine_fn = _search_bing_cn

    try:
        results = await engine_fn(query, num_results, proxy)
        logger.info("web_search [%s]: query='%s' results=%d", engine_name, query, len(results))
        return results
    except Exception:
        logger.exception("web_search [%s] error for query '%s'", engine_name, query)
        # If primary engine fails, try bing_cn as fallback (unless it was the primary)
        if engine_fn is not _search_bing_cn:
            try:
                logger.info("web_search: falling back to bing_cn for query '%s'", query)
                results = await _search_bing_cn(query, num_results, proxy)
                logger.info("web_search [bing_cn fallback]: query='%s' results=%d", query, len(results))
                return results
            except Exception:
                logger.exception("web_search [bing_cn fallback] also failed for query '%s'", query)
        return []


async def web_search_formatted(query: str, num_results: int = MAX_SEARCH_RESULTS) -> str:
    """Search the web and return formatted text results."""
    results = await web_search(query, num_results)

    if not results:
        return f"搜索 '{query}' 未返回结果。"

    lines = [f"搜索 '{query}' 的结果：", ""]
    for i, result in enumerate(results, 1):
        lines.append(f"[{i}] {result['title']}")
        lines.append(f"    URL: {result['url']}")
        lines.append(f"    摘要: {result['snippet']}")
        lines.append("")

    return "\n".join(lines)
