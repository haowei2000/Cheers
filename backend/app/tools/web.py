"""Web tools for bot capabilities: web_fetch and web_search."""

import json
import logging
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger("app.tools.web")

# Default content length limits to prevent token overflow
MAX_CONTENT_LENGTH = 15000
MAX_SEARCH_RESULTS = 5
REQUEST_TIMEOUT = 30.0

# User agent for ethical web crawling
USER_AGENT = "AgentNexusBot/1.0 (Research Assistant)"


def _is_valid_url(url: str) -> bool:
    """Validate that URL has valid scheme and netloc."""
    try:
        parsed = urlparse(url)
        return bool(parsed.scheme in ("http", "https") and parsed.netloc)
    except Exception:
        return False


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
        # Fallback to body text
        body = soup.find("body")
        if body:
            text = body.get_text(separator="\n", strip=True)
        else:
            text = soup.get_text(separator="\n", strip=True)

    # Clean up whitespace
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    text = "\n".join(lines)

    # Truncate if too long
    if len(text) > max_length:
        text = text[:max_length] + f"\n\n[Content truncated at {max_length} characters]"

    return text


async def web_fetch(url: str, max_length: int = MAX_CONTENT_LENGTH) -> str:
    """Fetch and extract text content from a URL.

    Args:
        url: The URL to fetch (must be http:// or https://)
        max_length: Maximum characters to return (default 15000)

    Returns:
        Extracted text content or error message
    """
    # Validate URL
    url = url.strip()
    if not _is_valid_url(url):
        return f"错误：无效的 URL '{url}'。请提供有效的 http:// 或 https:// 链接。"

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True) as client:
            headers = {
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Accept-Encoding": "identity",
            }
            response = await client.get(url, headers=headers)
            response.raise_for_status()

        # Check content type
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
            # Pretty print JSON
            try:
                data = response.json()
                json_text = json.dumps(data, ensure_ascii=False, indent=2)
                if len(json_text) > max_length:
                    json_text = json_text[:max_length] + "\n\n[JSON truncated...]"
                return f"URL: {url}\n类型: JSON\n---\n{json_text}"
            except json.JSONDecodeError:
                return f"URL: {url}\n---\n{response.text[:max_length]}"

        else:
            # Plain text or other content
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


async def web_search(query: str, num_results: int = MAX_SEARCH_RESULTS) -> list[dict]:
    """Search the web using DuckDuckGo.

    Args:
        query: Search query string
        num_results: Number of results to return (1-10, default 5)

    Returns:
        List of search result dictionaries with title, url, and snippet
    """
    # Validate and clamp num_results
    try:
        num_results = int(num_results)
    except (TypeError, ValueError):
        num_results = MAX_SEARCH_RESULTS

    num_results = max(1, min(10, num_results))

    query = query.strip()
    if not query:
        return []

    try:
        from duckduckgo_search import DDGS

        results = []
        with DDGS() as ddgs:
            search_results = ddgs.text(query, max_results=num_results)
            for result in search_results:
                results.append({
                    "title": result.get("title", ""),
                    "url": result.get("href", ""),
                    "snippet": result.get("body", ""),
                })

        logger.info("web_search: query='%s' results=%d", query, len(results))
        return results

    except Exception:
        logger.exception("web_search error for query '%s'", query)
        return []


async def web_search_formatted(query: str, num_results: int = MAX_SEARCH_RESULTS) -> str:
    """Search the web and return formatted text results.

    This is a convenience wrapper around web_search that returns a formatted string
    suitable for inclusion in LLM prompts.

    Args:
        query: Search query string
        num_results: Number of results to return (default 5)

    Returns:
        Formatted search results as a string
    """
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
