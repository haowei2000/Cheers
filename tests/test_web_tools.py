"""Tests for web tools: web_fetch and web_search."""

from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.tools.web import _extract_text_from_html, _is_valid_url, web_fetch, web_search, web_search_formatted


class TestIsValidUrl:
    """Tests for URL validation."""

    def test_valid_http_url(self):
        assert _is_valid_url("http://example.com") is True

    def test_valid_https_url(self):
        assert _is_valid_url("https://example.com") is True

    def test_valid_url_with_path(self):
        assert _is_valid_url("https://example.com/path/to/page") is True

    def test_invalid_no_scheme(self):
        assert _is_valid_url("example.com") is False

    def test_invalid_no_netloc(self):
        assert _is_valid_url("http://") is False

    def test_invalid_scheme(self):
        assert _is_valid_url("ftp://example.com") is False

    def test_empty_url(self):
        assert _is_valid_url("") is False


class TestExtractTextFromHtml:
    """Tests for HTML text extraction."""

    def test_extracts_text_from_simple_html(self):
        html = "<html><body><p>Hello World</p></body></html>"
        result = _extract_text_from_html(html)
        assert "Hello World" in result

    def test_removes_script_tags(self):
        html = "<html><body><script>alert('test')</script><p>Content</p></body></html>"
        result = _extract_text_from_html(html)
        assert "alert" not in result
        assert "Content" in result

    def test_removes_style_tags(self):
        html = "<html><head><style>.class{color:red}</style></head><body><p>Text</p></body></html>"
        result = _extract_text_from_html(html)
        assert "class{color" not in result
        assert "Text" in result

    def test_truncates_long_content(self):
        html = f"<html><body><p>{'x' * 20000}</p></body></html>"
        result = _extract_text_from_html(html, max_length=1000)
        assert len(result) <= 1100  # Allow for truncation message
        assert "truncated" in result.lower()


class TestWebFetch:
    """Tests for web_fetch function."""

    @pytest.mark.asyncio
    async def test_invalid_url_returns_error(self):
        result = await web_fetch("not-a-valid-url")
        assert "错误" in result or "error" in result.lower()
        assert "无效" in result or "invalid" in result.lower()

    @pytest.mark.asyncio
    async def test_empty_url_returns_error(self):
        result = await web_fetch("")
        assert "错误" in result or "error" in result.lower()

    @pytest.mark.asyncio
    async def test_fetch_html_success(self):
        mock_response = Mock()
        mock_response.headers = {"content-type": "text/html; charset=utf-8"}
        mock_response.text = "<html><head><title>Test Page</title></head><body><p>Hello World</p></body></html>"

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client.get = AsyncMock(return_value=mock_response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await web_fetch("https://example.com")

        assert "Test Page" in result
        assert "Hello World" in result
        assert "https://example.com" in result

    @pytest.mark.asyncio
    async def test_fetch_json_content(self):
        mock_response = Mock()
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json = Mock(return_value={"key": "value", "number": 123})

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client.get = AsyncMock(return_value=mock_response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await web_fetch("https://api.example.com/data")

        assert "JSON" in result
        assert '"key": "value"' in result

    @pytest.mark.asyncio
    async def test_fetch_timeout_error(self):
        import httpx

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("Connection timed out"))

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await web_fetch("https://example.com")

        assert "超时" in result or "timeout" in result.lower()

    @pytest.mark.asyncio
    async def test_fetch_http_error(self):
        import httpx

        mock_response = Mock()
        mock_response.status_code = 404
        mock_response.raise_for_status = Mock(side_effect=httpx.HTTPStatusError(
            "404 Not Found",
            request=Mock(),
            response=mock_response
        ))

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client.get = AsyncMock(return_value=mock_response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await web_fetch("https://example.com/notfound")

        assert "404" in result


class TestWebSearch:
    """Tests for web_search function."""

    @pytest.mark.asyncio
    async def test_search_with_results(self):
        mock_results = [
            {"title": "Result 1", "href": "https://example1.com", "body": "Snippet 1"},
            {"title": "Result 2", "href": "https://example2.com", "body": "Snippet 2"},
        ]

        mock_ddgs = Mock()
        mock_ddgs.text = Mock(return_value=mock_results)
        mock_ddgs.__enter__ = Mock(return_value=mock_ddgs)
        mock_ddgs.__exit__ = Mock(return_value=None)

        with patch("duckduckgo_search.DDGS", return_value=mock_ddgs):
            results = await web_search("test query", num_results=2)

        assert len(results) == 2
        assert results[0]["title"] == "Result 1"
        assert results[0]["url"] == "https://example1.com"
        assert results[0]["snippet"] == "Snippet 1"

    @pytest.mark.asyncio
    async def test_search_empty_query_returns_empty_list(self):
        results = await web_search("")
        assert results == []

    @pytest.mark.asyncio
    async def test_search_error_returns_empty_list(self):
        with patch("duckduckgo_search.DDGS", side_effect=Exception("Search failed")):
            results = await web_search("test query")

        assert results == []

    @pytest.mark.asyncio
    async def test_search_clamps_num_results(self):
        mock_ddgs = Mock()
        mock_ddgs.text = Mock(return_value=[])
        mock_ddgs.__enter__ = Mock(return_value=mock_ddgs)
        mock_ddgs.__exit__ = Mock(return_value=None)

        with patch("duckduckgo_search.DDGS", return_value=mock_ddgs):
            # Test with too high num_results
            await web_search("query", num_results=100)
            mock_ddgs.text.assert_called_once()
            # The clamped value should be used (max 10)


class TestWebSearchFormatted:
    """Tests for web_search_formatted function."""

    @pytest.mark.asyncio
    async def test_formatted_search_returns_string(self):
        mock_results = [
            {"title": "Python Documentation", "href": "https://python.org", "body": "Official Python docs"},
        ]

        mock_ddgs = Mock()
        mock_ddgs.text = Mock(return_value=mock_results)
        mock_ddgs.__enter__ = Mock(return_value=mock_ddgs)
        mock_ddgs.__exit__ = Mock(return_value=None)

        with patch("duckduckgo_search.DDGS", return_value=mock_ddgs):
            result = await web_search_formatted("python", num_results=1)

        assert isinstance(result, str)
        assert "Python Documentation" in result
        assert "https://python.org" in result
        assert "Official Python docs" in result

    @pytest.mark.asyncio
    async def test_formatted_search_no_results(self):
        mock_ddgs = Mock()
        mock_ddgs.text = Mock(return_value=[])
        mock_ddgs.__enter__ = Mock(return_value=mock_ddgs)
        mock_ddgs.__exit__ = Mock(return_value=None)

        with patch("duckduckgo_search.DDGS", return_value=mock_ddgs):
            result = await web_search_formatted("xyznotfound12345")

        assert "未返回结果" in result or "no results" in result.lower()
