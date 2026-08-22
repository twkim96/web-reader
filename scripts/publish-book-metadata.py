#!/usr/bin/env python3
"""Publish a compact, public Firestore projection from file_check metadata.

The command is dry-run by default. Pass --apply to upload through the Firestore
REST API using Application Default Credentials or a service-account credential.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

from public_book_catalog import build_catalog_documents, load_genre_resolver


PLATFORM_LABELS = {
    "series": "네이버 시리즈",
    "kakao": "카카오페이지",
    "novelpia": "노벨피아",
}
METRIC_FIELDS = (
    "download_count",
    "interest_count",
    "view_count",
    "recommend_count",
    "rating",
    "rating_count",
)
DEFAULT_DATABASE = Path(
    "/Users/twkim/Documents/GitHub/python/test/file_check/.dedup_state/"
    "dedup_decisions.sqlite3"
)
DEFAULT_NORMALIZER_VERSION = "1.3.3"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="file_check 플랫폼 메타데이터를 Web Reader 공개 컬렉션에 게시합니다.",
    )
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--project", help="Firebase project id. --apply에서 필수")
    parser.add_argument("--collection", default="publicBookMetadataV1")
    parser.add_argument(
        "--catalog-collection",
        default="publicBookCatalogIndexV1",
        help="책장 필터·정렬용 compact catalog collection",
    )
    parser.add_argument("--normalizer-version", default=DEFAULT_NORMALIZER_VERSION)
    parser.add_argument("--output", type=Path, help="dry-run JSONL 출력 경로")
    parser.add_argument(
        "--catalog-output",
        type=Path,
        help="compact catalog dry-run JSONL 출력 경로",
    )
    parser.add_argument(
        "--skip-catalog",
        action="store_true",
        help="기존 상세 projection만 생성·게시",
    )
    parser.add_argument("--limit", type=int, default=0, help="검증용 문서 수 제한")
    parser.add_argument("--apply", action="store_true", help="Firestore에 실제 게시")
    parser.add_argument(
        "--allow-create",
        action="store_true",
        help="Firestore 문서가 없을 때 생성. 기본은 기존 문서 갱신만 허용",
    )
    return parser.parse_args()


def open_readonly(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise FileNotFoundError(path)
    connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def require_schema(
    connection: sqlite3.Connection,
    *,
    include_catalog: bool = False,
) -> None:
    names = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
        )
    }
    required = {"catalog_titles", "catalog_platform_stats", "file_analysis"}
    if include_catalog:
        required.add("catalog_platform_tags")
    missing = sorted(required - names)
    if missing:
        raise RuntimeError(f"required file_check schema is missing: {', '.join(missing)}")
    platform_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(catalog_platform_stats)")
    }
    if "cover_url" not in platform_columns:
        raise RuntimeError("file_check catalog_platform_stats.cover_url is required")


def alias_text(value: str) -> str:
    import re
    import unicodedata

    normalized = unicodedata.normalize("NFC", value).lower()
    normalized = re.sub(r"\.(?:epub|txt|pdf|zip|cbz|7z)$", "", normalized, flags=re.I)
    return "".join(
        char
        for char in normalized
        if char.isascii() and char.isalnum()
        or "가" <= char <= "힣"
        or "\u3400" <= char <= "\u9fff"
        or "\uf900" <= char <= "\ufaff"
    )


def alias_id(value: str) -> str | None:
    alias = alias_text(value)
    return hashlib.sha256(alias.encode("utf-8")).hexdigest() if alias else None


def public_platform(row: sqlite3.Row) -> dict[str, Any]:
    payload = {
        "platform": row["platform"],
        "label": PLATFORM_LABELS[row["platform"]],
        "title": row["remote_title"],
        "url": row["remote_url"],
        "lastSuccessAt": row["last_success_at"],
    }
    cover_url = row["cover_url"]
    if cover_url is not None:
        if not str(cover_url).startswith("https://"):
            raise ValueError(f"invalid cover_url for {row['platform']}: {cover_url!r}")
        payload["coverUrl"] = cover_url
    for field in METRIC_FIELDS:
        camel = field.split("_")[0] + "".join(part.title() for part in field.split("_")[1:])
        payload[camel] = row[field]
    return payload


def build_documents(
    connection: sqlite3.Connection,
    published_at: str,
    normalizer_version: str,
) -> tuple[list[dict[str, Any]], int]:
    if not normalizer_version:
        raise ValueError("normalizer version must not be empty")
    titles = {
        row["title_key"]: row
        for row in connection.execute(
            "SELECT title_key, display_title FROM catalog_titles "
            "WHERE normalizer_version = ? ORDER BY title_key",
            (normalizer_version,),
        )
    }
    platforms: dict[str, list[dict[str, Any]]] = {}
    for row in connection.execute(
        """
        SELECT * FROM catalog_platform_stats
        WHERE status = 'ok'
          AND platform IN ('series', 'kakao', 'novelpia')
          AND remote_title IS NOT NULL
          AND remote_url LIKE 'https://%'
          AND last_success_at IS NOT NULL
        ORDER BY title_key, platform
        """
    ):
        platforms.setdefault(row["title_key"], []).append(public_platform(row))

    aliases: dict[str, set[str]] = {title_key: set() for title_key in platforms}
    for title_key, title in titles.items():
        if title_key in aliases:
            aliases[title_key].update((title_key, str(title["display_title"] or "")))
    for row in connection.execute(
        "SELECT core_title, analyzed_name, readable_title, catalog_query_title "
        "FROM file_analysis WHERE normalizer_version = ?",
        (normalizer_version,),
    ):
        title_key = str(row["core_title"] or "")
        if title_key not in aliases:
            continue
        aliases[title_key].update(
            str(row[field] or "")
            for field in ("analyzed_name", "readable_title", "catalog_query_title")
        )

    candidates: dict[str, dict[str, dict[str, Any]]] = {}
    for title_key, platform_rows in platforms.items():
        title = titles.get(title_key)
        if title is None:
            continue
        payload = {
            "schemaVersion": 1,
            "titleKey": title_key,
            "displayTitle": title["display_title"],
            "normalizerVersion": normalizer_version,
            "publishedAt": published_at,
            "platforms": platform_rows,
        }
        for raw_alias in aliases[title_key]:
            document_id = alias_id(raw_alias)
            if document_id is None:
                continue
            candidates.setdefault(document_id, {})[title_key] = payload
    collisions = sum(1 for matches in candidates.values() if len(matches) > 1)
    documents = [
        {"documentId": document_id, **next(iter(matches.values()))}
        for document_id, matches in sorted(candidates.items())
        if len(matches) == 1
    ]
    return documents, collisions


def bucket_documents(
    aliases: Iterable[dict[str, Any]],
    *,
    published_at: str,
    normalizer_version: str,
) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, dict[str, Any]]] = {}
    for document in aliases:
        document_id = document["documentId"]
        buckets.setdefault(document_id[:2], {})[document_id] = {
            key: value for key, value in document.items() if key != "documentId"
        }
    documents = []
    for bucket_id, entries in sorted(buckets.items()):
        payload = {
            "documentId": bucket_id,
            "schemaVersion": 1,
            "publishedAt": published_at,
            "normalizerVersion": normalizer_version,
            "entries": entries,
        }
        encoded_size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        if encoded_size > 900_000:
            raise RuntimeError(
                f"metadata bucket exceeds safe Firestore size: {bucket_id}={encoded_size}"
            )
        documents.append(payload)
    return documents


def firestore_value(value: Any) -> dict[str, Any]:
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [firestore_value(item) for item in value]}}
    if isinstance(value, dict):
        return {"mapValue": {"fields": {
            key: firestore_value(item) for key, item in value.items()
        }}}
    raise TypeError(type(value))


def firestore_native_value(value: Any) -> Any:
    """Decode the REST Value shape for exact readback comparison.

    Firestore may omit empty ``values``/``fields`` containers in responses, so
    comparing the wire dictionaries directly can reject a valid immutable
    generation that contains an empty tag array or shard map.
    """
    if not isinstance(value, dict):
        raise ValueError("Firestore value must be an object")
    if "nullValue" in value:
        return None
    if "booleanValue" in value:
        return bool(value["booleanValue"])
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "stringValue" in value:
        return str(value["stringValue"])
    if "arrayValue" in value:
        container = value["arrayValue"]
        if not isinstance(container, dict):
            raise ValueError("Firestore arrayValue must be an object")
        return [firestore_native_value(item) for item in container.get("values", [])]
    if "mapValue" in value:
        container = value["mapValue"]
        if not isinstance(container, dict):
            raise ValueError("Firestore mapValue must be an object")
        fields = container.get("fields", {})
        if not isinstance(fields, dict):
            raise ValueError("Firestore map fields must be an object")
        return {key: firestore_native_value(item) for key, item in fields.items()}
    raise ValueError(f"unsupported Firestore value: {sorted(value)}")


def firestore_document_payload(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict) or not isinstance(document.get("fields"), dict):
        raise ValueError("Firestore document fields are missing")
    return {
        key: firestore_native_value(value)
        for key, value in document["fields"].items()
    }


def authorized_firestore_session(project: str):
    """Create a Firestore session from an action secret or normal ADC.

    Control Server actions can pass the same service-account JSON shape used by
    the Vercel server without writing a temporary credential file. Local CLI
    users can keep using Application Default Credentials.
    """
    try:
        import google.auth
        from google.auth.transport.requests import AuthorizedSession
        from google.oauth2 import service_account
    except ImportError as error:
        raise RuntimeError("google-auth[requests] is required for --apply") from error

    raw_service_account = os.environ.get("FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON", "").strip()
    if raw_service_account:
        try:
            service_account_info = json.loads(raw_service_account)
        except json.JSONDecodeError as error:
            raise RuntimeError(
                "FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON must be valid JSON"
            ) from error
        if not isinstance(service_account_info, dict):
            raise RuntimeError("FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON must contain a JSON object")
        try:
            credentials = service_account.Credentials.from_service_account_info(
                service_account_info,
                scopes=("https://www.googleapis.com/auth/datastore",),
            )
        except (TypeError, ValueError) as error:
            raise RuntimeError("FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON is invalid") from error
        detected_project = str(service_account_info.get("project_id") or "") or None
    else:
        credentials, detected_project = google.auth.default(
            scopes=("https://www.googleapis.com/auth/datastore",),
        )

    project_id = project or detected_project
    if not project_id:
        raise RuntimeError("--project is required when credentials have no project id")
    return AuthorizedSession(credentials), project_id


def publish_documents(
    documents: Iterable[dict[str, Any]],
    *,
    project: str,
    collection: str,
    allow_create: bool,
) -> tuple[int, int]:
    session, project_id = authorized_firestore_session(project)
    base = (
        f"https://firestore.googleapis.com/v1/projects/{quote(project_id, safe='')}"
        f"/databases/(default)/documents/{quote(collection, safe='')}"
    )
    created = updated = 0
    for document in documents:
        document_id = document["documentId"]
        body = {"fields": {
            key: firestore_value(value)
            for key, value in document.items()
            if key != "documentId"
        }}
        url = f"{base}/{document_id}?currentDocument.exists=true"
        response = session.patch(url, json=body, timeout=30)
        if response.status_code == 404 and allow_create:
            response = session.post(
                f"{base}?documentId={document_id}",
                json=body,
                timeout=30,
            )
            created += 1
        else:
            updated += 1
        if not response.ok:
            raise RuntimeError(
                f"Firestore publish failed for {document_id}: "
                f"{response.status_code} {response.text[:500]}"
            )
    return created, updated


def publish_catalog_documents(
    documents: Iterable[dict[str, Any]],
    manifest: dict[str, Any],
    *,
    project: str,
    collection: str,
) -> tuple[int, int]:
    """Create immutable generation documents, verify them, then CAS the manifest."""
    session, project_id = authorized_firestore_session(project)
    base = (
        f"https://firestore.googleapis.com/v1/projects/{quote(project_id, safe='')}"
        f"/databases/(default)/documents/{quote(collection, safe='')}"
    )
    immutable = list(documents)
    created = reused = 0
    for document in immutable:
        document_id = str(document["documentId"])
        expected_payload = {
            key: value for key, value in document.items() if key != "documentId"
        }
        fields = {
            key: firestore_value(value) for key, value in expected_payload.items()
        }
        response = session.post(
            f"{base}?documentId={quote(document_id, safe='')}",
            json={"fields": fields},
            timeout=30,
        )
        if response.status_code == 409:
            existing = session.get(
                f"{base}/{quote(document_id, safe='')}",
                timeout=30,
            )
            if (
                not existing.ok
                or firestore_document_payload(existing.json()) != expected_payload
            ):
                raise RuntimeError(
                    f"catalog generation collision for {document_id}: "
                    f"{existing.status_code} {existing.text[:500]}"
                )
            reused += 1
        elif response.ok:
            created += 1
        else:
            raise RuntimeError(
                f"catalog publish failed for {document_id}: "
                f"{response.status_code} {response.text[:500]}"
            )

    for document in immutable:
        document_id = str(document["documentId"])
        expected_payload = {
            key: value for key, value in document.items() if key != "documentId"
        }
        response = session.get(
            f"{base}/{quote(document_id, safe='')}",
            timeout=30,
        )
        if (
            not response.ok
            or firestore_document_payload(response.json()) != expected_payload
        ):
            raise RuntimeError(
                f"catalog readback failed for {document_id}: "
                f"{response.status_code} {response.text[:500]}"
            )

    manifest_fields = {
        key: firestore_value(value)
        for key, value in manifest.items()
        if key != "documentId"
    }
    manifest_url = f"{base}/manifest"
    current = session.get(manifest_url, timeout=30)
    if current.status_code == 404:
        response = session.post(
            f"{base}?documentId=manifest",
            json={"fields": manifest_fields},
            timeout=30,
        )
    elif current.ok:
        update_time = str(current.json().get("updateTime") or "")
        if not update_time:
            raise RuntimeError("catalog manifest updateTime is missing")
        response = session.patch(
            f"{manifest_url}?currentDocument.updateTime={quote(update_time, safe='')}",
            json={"fields": manifest_fields},
            timeout=30,
        )
    else:
        raise RuntimeError(
            f"catalog manifest read failed: {current.status_code} {current.text[:500]}"
        )
    if not response.ok:
        raise RuntimeError(
            f"catalog manifest publish failed: {response.status_code} {response.text[:500]}"
        )
    if firestore_document_payload(response.json()) != {
        key: value for key, value in manifest.items() if key != "documentId"
    }:
        raise RuntimeError("catalog manifest response does not match the requested payload")
    return created, reused


def main() -> int:
    args = parse_args()
    if args.limit < 0:
        raise ValueError("--limit must be zero or positive")
    published_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    catalog_documents: list[dict[str, Any]] = []
    catalog_manifest: dict[str, Any] | None = None
    catalog_summary: dict[str, Any] | None = None
    with open_readonly(args.database) as connection:
        require_schema(connection, include_catalog=not args.skip_catalog)
        aliases, collision_count = build_documents(
            connection,
            published_at,
            args.normalizer_version,
        )
        documents = bucket_documents(
            aliases,
            published_at=published_at,
            normalizer_version=args.normalizer_version,
        )
        if not args.skip_catalog:
            catalog_documents, catalog_manifest, catalog_summary = build_catalog_documents(
                connection,
                aliases,
                published_at=published_at,
                normalizer_version=args.normalizer_version,
                excluded_alias_collisions=collision_count,
                resolve_genre=load_genre_resolver(args.database),
            )
    if args.limit:
        documents = documents[: args.limit]
    summary = {
        "mode": "apply" if args.apply else "dry-run",
        "database": str(args.database),
        "collection": args.collection,
        "documents": len(documents),
        "publishedAt": published_at,
        "normalizerVersion": args.normalizer_version,
        "excludedAliasCollisions": collision_count,
        "aliases": len(aliases),
    }
    if catalog_summary is not None:
        summary["catalog"] = {
            "collection": args.catalog_collection,
            **catalog_summary,
        }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", encoding="utf-8") as handle:
            for document in documents:
                handle.write(json.dumps(document, ensure_ascii=False, separators=(",", ":")))
                handle.write("\n")
        summary["output"] = str(args.output)
    if args.catalog_output and catalog_manifest is not None:
        args.catalog_output.parent.mkdir(parents=True, exist_ok=True)
        with args.catalog_output.open("w", encoding="utf-8") as handle:
            for document in [*catalog_documents, catalog_manifest]:
                handle.write(json.dumps(document, ensure_ascii=False, separators=(",", ":")))
                handle.write("\n")
        summary["catalogOutput"] = str(args.catalog_output)
    if args.apply:
        if not args.project:
            raise RuntimeError("--project is required for --apply")
        created, updated = publish_documents(
            documents,
            project=args.project,
            collection=args.collection,
            allow_create=args.allow_create,
        )
        summary.update({"created": created, "updated": updated})
        if catalog_manifest is not None:
            catalog_created, catalog_reused = publish_catalog_documents(
                catalog_documents,
                catalog_manifest,
                project=args.project,
                collection=args.catalog_collection,
            )
            summary["catalog"].update({
                "created": catalog_created,
                "reused": catalog_reused,
                "manifestUpdated": True,
            })
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
