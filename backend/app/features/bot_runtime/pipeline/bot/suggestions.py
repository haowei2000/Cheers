"""Suggestions module."""
import re

# Match "suggest @xxx" patterns, including the legacy Chinese variants.
SUGGEST_PATTERN = re.compile(r"建议\s*@([a-zA-Z0-9_一-鿿]+)")


def extract_suggested_bots(content: str) -> list[str]:
    """Extract suggested bots."""
    return list(dict.fromkeys(SUGGEST_PATTERN.findall(content)))
