"""Project public metadata and catalog shards into a compact discovery index."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from public_book_catalog import PLATFORMS, checksum, stable_json


def _text(value: Any, limit: int) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-16-le")) // 2 > limit:
        raise ValueError("invalid discovery text")
    return value


def _url(value: Any, limit: int) -> str:
    value = _text(value, limit)
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or any(ord(c) <= 32 or ord(c) == 127 for c in value)):
        raise ValueError("invalid discovery HTTPS URL")
    return value


def build_discovery(aliases: list[dict[str, Any]], documents: list[dict[str, Any]],
                    manifest: dict[str, Any]) -> dict[str, Any]:
    payloads = {alias["titleKey"]: alias for alias in aliases}
    title_keys = sorted(payloads)
    shards = [doc for doc in documents if doc.get("kind") == "catalog"]
    zero = next(doc for doc in shards if doc["shard"] == 0)
    genres = [zero["genres"][str(i)] for i in range(len(zero["genres"]))]
    tags = [zero["tags"][str(i)]["l"] for i in range(len(zero["tags"]))]
    records = {key: record for doc in shards for key, record in doc["records"].items()}
    if len(title_keys) != manifest["titleCount"] or len(records) != len(title_keys):
        raise ValueError("discovery catalog title mismatch")
    books = []
    for index, key in enumerate(title_keys):
        payload = payloads[key]
        by_platform = {item["platform"]: item for item in payload["platforms"]}
        if len(by_platform) != len(payload["platforms"]) or not set(by_platform) <= set(PLATFORMS):
            raise ValueError("invalid discovery platforms")
        platforms = [[item["platform"], _url(item["url"], 1000)]
                     for item in payload["platforms"]]
        covers = [_url(by_platform[p]["coverUrl"], 2000) for p in PLATFORMS
                  if p in by_platform and by_platform[p].get("coverUrl") is not None]
        record = records[str(index)]
        counts = [count for count in record["c"] if count is not None]
        books.append([_text(key, 500), _text(payload["displayTitle"], 500),
                      covers[0] if covers else None, platforms, record["g"], record["t"],
                      record["s"], max(counts) if counts else None])
    content = {"schemaVersion": 1, "genres": genres, "tags": tags, "books": books}
    return {"schemaVersion": 1, "generation": checksum(content),
            "genres": genres, "tags": tags, "books": books}


def discovery_bytes(discovery: dict[str, Any]) -> bytes:
    return (stable_json(discovery) + "\n").encode("utf-8")
