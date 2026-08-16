from __future__ import annotations

import sqlite3
import sys
import unittest
import importlib.util
from pathlib import Path
from types import SimpleNamespace


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from public_book_catalog import build_catalog_documents  # noqa: E402

PUBLISHER_SPEC = importlib.util.spec_from_file_location(
    "publish_book_metadata",
    Path(__file__).resolve().parents[1] / "scripts" / "publish-book-metadata.py",
)
if PUBLISHER_SPEC is None or PUBLISHER_SPEC.loader is None:
    raise RuntimeError("publisher module could not be loaded")
PUBLISHER = importlib.util.module_from_spec(PUBLISHER_SPEC)
PUBLISHER_SPEC.loader.exec_module(PUBLISHER)


class PublicBookCatalogPublisherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            """
            CREATE TABLE catalog_platform_stats (
                title_key TEXT NOT NULL,
                platform TEXT NOT NULL,
                genre TEXT
            );
            CREATE TABLE catalog_platform_tags (
                title_key TEXT NOT NULL,
                platform TEXT NOT NULL,
                tag TEXT NOT NULL,
                position INTEGER NOT NULL
            );
            """
        )
        self.connection.executemany(
            "INSERT INTO catalog_platform_stats VALUES (?, ?, ?)",
            [
                ("가", "series", "판타지"),
                ("나", "series", "현판"),
                ("나", "kakao", "현대판타지"),
            ],
        )
        self.connection.executemany(
            "INSERT INTO catalog_platform_tags VALUES (?, ?, ?, ?)",
            [
                ("가", "series", "하렘", 0),
                ("가", "series", "성장", 1),
                ("나", "series", "성장", 0),
                ("나", "kakao", "회귀", 0),
            ],
        )
        self.aliases = [
            {
                "documentId": "0" * 64,
                "titleKey": "가",
                "platforms": [{
                    "platform": "series",
                    "downloadCount": 100,
                    "viewCount": None,
                }],
            },
            {
                "documentId": "f" * 64,
                "titleKey": "나",
                "platforms": [
                    {
                        "platform": "series",
                        "downloadCount": 300,
                        "viewCount": None,
                    },
                    {
                        "platform": "kakao",
                        "downloadCount": None,
                        "viewCount": 1_000,
                    },
                ],
            },
        ]

    def tearDown(self) -> None:
        self.connection.close()

    @staticmethod
    def resolve_genre(sources):
        genres = [str(genre) for _, genre, _ in sources if genre]
        return SimpleNamespace(canonical_genre=genres[0] if genres else None)

    def build(self, published_at: str):
        return build_catalog_documents(
            self.connection,
            self.aliases,
            published_at=published_at,
            normalizer_version="1.3.3",
            excluded_alias_collisions=1,
            resolve_genre=self.resolve_genre,
        )

    def test_builds_content_addressed_shards_with_source_counts_and_tags(self) -> None:
        documents, manifest, summary = self.build("2026-08-17T00:00:00+00:00")
        self.assertEqual(len(documents), 24)
        self.assertEqual(summary["documents"], 25)
        self.assertLess(summary["maxDocumentBytes"], 900_000)
        self.assertEqual(manifest["aliasCount"], 2)
        self.assertEqual(manifest["titleCount"], 2)
        catalog_zero = next(
            document for document in documents
            if document["documentId"].endswith("_catalog_0")
        )
        records = {
            record_id: record
            for document in documents
            if document.get("kind") == "catalog"
            for record_id, record in document["records"].items()
        }
        self.assertEqual(records["0"]["c"], [100, None, None])
        self.assertEqual(records["1"]["c"], [300, 1_000, None])
        self.assertLess(records["0"]["r"][0], records["1"]["r"][0])
        tags = {value["l"]: value["n"] for value in catalog_zero["tags"].values()}
        self.assertEqual(tags, {"성장": 2, "하렘": 1, "회귀": 1})

    def test_generation_is_stable_when_only_publish_time_changes(self) -> None:
        first_documents, first_manifest, _ = self.build("2026-08-17T00:00:00+00:00")
        second_documents, second_manifest, _ = self.build("2026-08-18T00:00:00+00:00")
        self.assertEqual(first_manifest["generation"], second_manifest["generation"])
        self.assertEqual(first_documents, second_documents)
        self.assertNotEqual(first_manifest["publishedAt"], second_manifest["publishedAt"])

    def test_decodes_firestore_readback_with_omitted_empty_containers(self) -> None:
        document = {
            "fields": {
                "count": {"integerValue": "12"},
                "tags": {"arrayValue": {}},
                "records": {"mapValue": {}},
                "nested": {"mapValue": {"fields": {
                    "enabled": {"booleanValue": True},
                    "missing": {"nullValue": None},
                }}},
            },
        }
        self.assertEqual(PUBLISHER.firestore_document_payload(document), {
            "count": 12,
            "tags": [],
            "records": {},
            "nested": {"enabled": True, "missing": None},
        })


if __name__ == "__main__":
    unittest.main()
