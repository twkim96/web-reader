"""Build the immutable compact public catalog used by the Web Reader shelf."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence


PLATFORMS = ("series", "kakao", "novelpia")
PLATFORM_BITS = {"series": 1, "kakao": 2, "novelpia": 4}
SOURCE_METRICS = {
    "series": "downloadCount",
    "kakao": "viewCount",
    "novelpia": "viewCount",
}
ALIAS_SHARDS = 16
CATALOG_SHARDS = 8
SAFE_DOCUMENT_BYTES = 900_000

GenreResolver = Callable[
    [Iterable[tuple[str, object, Sequence[object] | None]]],
    object,
]


def _round_half_up(value: float) -> int:
    return math.floor(value + 0.5)


def stable_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def checksum(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def encoded_size(value: Any) -> int:
    return len(stable_json(value).encode("utf-8"))


def load_genre_resolver(database: Path) -> GenreResolver:
    repository = database.resolve().parent.parent
    module_path = repository / "backend" / "genre_flattening.py"
    if not module_path.is_file():
        raise RuntimeError(f"file_check genre projection is missing: {module_path}")
    spec = importlib.util.spec_from_file_location(
        "file_check_genre_flattening",
        module_path,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load file_check genre projection: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    resolver = getattr(module, "resolve_canonical_genre", None)
    if not callable(resolver):
        raise RuntimeError("file_check genre resolver is unavailable")
    return resolver


def _midranks(values: Sequence[int | float]) -> dict[int | float, int]:
    counts = Counter(values)
    total = sum(counts.values())
    less = 0
    ranks: dict[int | float, int] = {}
    for value in sorted(counts):
        equal = counts[value]
        ranks[value] = _round_half_up(10_000 * (less + 0.5 * equal) / total)
        less += equal
    return ranks


def _bounded_tag(value: object) -> str | None:
    tag = str(value or "").strip()
    utf16_length = len(tag.encode("utf-16-le")) // 2
    if not tag or utf16_length > 100:
        return None
    return tag


def _document(
    document_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    document = {"documentId": document_id, **payload}
    size = encoded_size(document)
    if size > SAFE_DOCUMENT_BYTES:
        raise RuntimeError(
            f"catalog document exceeds safe Firestore size: {document_id}={size}"
        )
    return document


def build_catalog_documents(
    connection: sqlite3.Connection,
    aliases: Sequence[dict[str, Any]],
    *,
    published_at: str,
    normalizer_version: str,
    excluded_alias_collisions: int,
    resolve_genre: GenreResolver,
) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    """Build 16 alias shards, 8 catalog shards, and a manifest.

    The dense numeric title IDs are generation-local. The generation itself is
    content-addressed so an unchanged SQLite projection reuses cached documents.
    """
    title_payloads: dict[str, dict[str, Any]] = {}
    alias_to_title: dict[str, str] = {}
    for alias in aliases:
        title_key = str(alias["titleKey"])
        title_payloads.setdefault(title_key, alias)
        alias_to_title[str(alias["documentId"])] = title_key

    title_keys = sorted(title_payloads)
    title_ids = {title_key: index for index, title_key in enumerate(title_keys)}
    valid_pairs = {
        (title_key, str(platform["platform"]))
        for title_key, payload in title_payloads.items()
        for platform in payload["platforms"]
    }

    genres_by_pair: dict[tuple[str, str], object] = {}
    if title_keys:
        placeholders = ",".join("?" for _ in title_keys)
        rows = connection.execute(
            f"""
            SELECT title_key, platform, genre
            FROM catalog_platform_stats
            WHERE title_key IN ({placeholders})
            ORDER BY title_key, platform
            """,
            title_keys,
        )
        for row in rows:
            pair = (str(row["title_key"]), str(row["platform"]))
            if pair in valid_pairs:
                genres_by_pair[pair] = row["genre"]

    tags_by_pair: dict[tuple[str, str], list[str]] = defaultdict(list)
    if title_keys:
        placeholders = ",".join("?" for _ in title_keys)
        rows = connection.execute(
            f"""
            SELECT title_key, platform, tag
            FROM catalog_platform_tags
            WHERE title_key IN ({placeholders})
            ORDER BY title_key, platform, position
            """,
            title_keys,
        )
        for row in rows:
            pair = (str(row["title_key"]), str(row["platform"]))
            tag = _bounded_tag(row["tag"])
            if pair in valid_pairs and tag is not None:
                tags_by_pair[pair].append(tag)

    canonical_genres: dict[str, str | None] = {}
    raw_tags_by_title: dict[str, list[str]] = {}
    tag_title_counts: Counter[str] = Counter()
    for title_key in title_keys:
        resolution = resolve_genre(
            (
                platform,
                genres_by_pair.get((title_key, platform)),
                tags_by_pair.get((title_key, platform), ()),
            )
            for platform in PLATFORMS
            if (title_key, platform) in valid_pairs
        )
        canonical = getattr(resolution, "canonical_genre", None)
        canonical_genres[title_key] = str(canonical) if canonical else None
        ordered_tags = list(dict.fromkeys(
            tag
            for platform in PLATFORMS
            for tag in tags_by_pair.get((title_key, platform), ())
        ))
        if len(ordered_tags) > 64:
            raise RuntimeError(
                f"catalog title exceeds the client tag limit: {title_key}={len(ordered_tags)}"
            )
        raw_tags_by_title[title_key] = ordered_tags
        tag_title_counts.update(set(ordered_tags))

    genre_labels = sorted({
        genre for genre in canonical_genres.values() if genre is not None
    })
    genre_ids = {label: index for index, label in enumerate(genre_labels)}
    tag_labels = sorted(tag_title_counts)
    tag_ids = {label: index for index, label in enumerate(tag_labels)}

    source_values: dict[str, list[int | float]] = {platform: [] for platform in PLATFORMS}
    source_counts_by_title: dict[str, dict[str, int | float | None]] = {}
    for title_key, payload in title_payloads.items():
        by_platform = {
            str(platform["platform"]): platform
            for platform in payload["platforms"]
        }
        counts: dict[str, int | float | None] = {}
        for platform in PLATFORMS:
            row = by_platform.get(platform)
            value = row.get(SOURCE_METRICS[platform]) if row else None
            count = (
                int(value)
                if (
                    isinstance(value, (int, float))
                    and not isinstance(value, bool)
                    and math.isfinite(value)
                    and value >= 0
                    and float(value).is_integer()
                )
                else None
            )
            counts[platform] = count
            if count is not None:
                source_values[platform].append(count)
        source_counts_by_title[title_key] = counts

    source_rank_maps = {
        platform: _midranks(values) if values else {}
        for platform, values in source_values.items()
    }

    records: dict[str, dict[str, Any]] = {}
    for title_key in title_keys:
        payload = title_payloads[title_key]
        platforms = {str(row["platform"]) for row in payload["platforms"]}
        counts = source_counts_by_title[title_key]
        source_counts = [counts[platform] for platform in PLATFORMS]
        source_ranks = [
            source_rank_maps[platform].get(counts[platform])
            if counts[platform] is not None else None
            for platform in PLATFORMS
        ]
        present_ranks = [rank for rank in source_ranks if rank is not None]
        popularity_score = (
            _round_half_up(sum(present_ranks) / len(present_ranks))
            if present_ranks else None
        )
        canonical = canonical_genres[title_key]
        records[str(title_ids[title_key])] = {
            "p": sum(PLATFORM_BITS[platform] for platform in platforms),
            "g": genre_ids[canonical] if canonical is not None else None,
            "t": [tag_ids[tag] for tag in raw_tags_by_title[title_key]],
            "s": popularity_score,
            "r": source_ranks,
            "c": source_counts,
        }

    alias_entries = {
        alias_id: title_ids[title_key]
        for alias_id, title_key in sorted(alias_to_title.items())
    }
    tag_dictionary = {
        str(tag_ids[label]): {"l": label, "n": tag_title_counts[label]}
        for label in tag_labels
    }
    genre_dictionary = {
        str(genre_ids[label]): label for label in genre_labels
    }
    content = {
        "normalizerVersion": normalizer_version,
        "aliasEntries": alias_entries,
        "records": records,
        "tags": tag_dictionary,
        "genres": genre_dictionary,
        "popularityFormulaVersion": 1,
    }
    generation = checksum(content)[:20]

    alias_shards: list[dict[str, int]] = [dict() for _ in range(ALIAS_SHARDS)]
    for alias_id, title_id in alias_entries.items():
        alias_shards[int(alias_id[0], 16)][alias_id] = title_id

    record_shards: list[dict[str, dict[str, Any]]] = [
        dict() for _ in range(CATALOG_SHARDS)
    ]
    for title_id, record in records.items():
        record_shards[int(title_id) % CATALOG_SHARDS][title_id] = record

    documents: list[dict[str, Any]] = []
    for index, entries in enumerate(alias_shards):
        document_id = f"{generation}_alias_{index:x}"
        documents.append(_document(document_id, {
            "schemaVersion": 1,
            "generation": generation,
            "kind": "alias",
            "shard": index,
            "entries": entries,
        }))
    for index, shard_records in enumerate(record_shards):
        document_id = f"{generation}_catalog_{index}"
        payload: dict[str, Any] = {
            "schemaVersion": 1,
            "generation": generation,
            "kind": "catalog",
            "shard": index,
            "records": shard_records,
        }
        if index == 0:
            payload.update({"tags": tag_dictionary, "genres": genre_dictionary})
        documents.append(_document(document_id, payload))

    document_checksums = {
        document["documentId"]: checksum({
            key: value for key, value in document.items() if key != "documentId"
        })
        for document in documents
    }
    manifest = _document("manifest", {
        "schemaVersion": 1,
        "generation": generation,
        "publishedAt": published_at,
        "normalizerVersion": normalizer_version,
        "genrePolicyVersion": "file_check-v1",
        "popularityFormulaVersion": 1,
        "aliasDocuments": [
            document["documentId"]
            for document in documents
            if document["kind"] == "alias"
        ],
        "catalogDocuments": [
            document["documentId"]
            for document in documents
            if document["kind"] == "catalog"
        ],
        "aliasCount": len(alias_entries),
        "titleCount": len(title_keys),
        "tagCount": len(tag_labels),
        "genreCount": len(genre_labels),
        "excludedAliasCollisionCount": excluded_alias_collisions,
        "checksums": document_checksums,
    })
    summary = {
        "generation": generation,
        "documents": len(documents) + 1,
        "generationDocuments": len(documents),
        "aliases": len(alias_entries),
        "titles": len(title_keys),
        "tags": len(tag_labels),
        "genres": len(genre_labels),
        "rawBytes": sum(encoded_size(document) for document in documents)
        + encoded_size(manifest),
        "maxDocumentBytes": max(
            encoded_size(document) for document in [*documents, manifest]
        ),
    }
    return documents, manifest, summary
