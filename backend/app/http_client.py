"""全局共享 httpx.AsyncClient，复用 TCP 连接降低延迟。"""
import httpx

_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    if _client is None:
        raise RuntimeError("HTTP client not initialized; call init_http_client() first")
    return _client


async def init_http_client() -> None:
    global _client
    _client = httpx.AsyncClient(
        timeout=None,  # 由调用方按请求传入 timeout
        limits=httpx.Limits(
            max_connections=100,
            max_keepalive_connections=20,
            keepalive_expiry=30,
        ),
    )


async def close_http_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
