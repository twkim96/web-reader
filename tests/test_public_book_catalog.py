from __future__ import annotations

import sqlite3
import subprocess
import sys
import io
import json
import tempfile
import unittest
import importlib.util
from contextlib import redirect_stdout
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from public_book_catalog import build_catalog_documents  # noqa: E402
from public_book_discovery import build_discovery, discovery_bytes  # noqa: E402

PUBLISHER_SPEC = importlib.util.spec_from_file_location(
    "publish_book_metadata",
    Path(__file__).resolve().parents[1] / "scripts" / "publish-book-metadata.py",
)
if PUBLISHER_SPEC is None or PUBLISHER_SPEC.loader is None:
    raise RuntimeError("publisher module could not be loaded")
PUBLISHER = importlib.util.module_from_spec(PUBLISHER_SPEC)
PUBLISHER_SPEC.loader.exec_module(PUBLISHER)


PREVIEW_SPEC = importlib.util.spec_from_file_location(
    "publish_book_metadata_preview",
    Path(__file__).resolve().parents[1] / "scripts" / "publish-book-metadata-preview.py",
)
if PREVIEW_SPEC is None or PREVIEW_SPEC.loader is None:
    raise RuntimeError("preview publisher module could not be loaded")
PREVIEW = importlib.util.module_from_spec(PREVIEW_SPEC)
PREVIEW_SPEC.loader.exec_module(PREVIEW)


class DiscoveryPreviewPublishTests(unittest.TestCase):
    def test_retries_the_published_index_after_push_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            remote = root / "remote.git"
            repo = root / "repo"
            PREVIEW.git("init", "--bare", str(remote), cwd=root)
            PREVIEW.git("init", str(repo), cwd=root)
            PREVIEW.git("config", "user.name", "Catalog test", cwd=repo)
            PREVIEW.git("config", "user.email", "catalog@example.test", cwd=repo)
            PREVIEW.git("remote", "add", "origin", str(remote), cwd=repo)
            index = repo / PREVIEW.INDEX
            index.parent.mkdir(parents=True)
            index.write_text("old")
            publisher = repo / "scripts/publish-book-metadata.py"
            publisher.parent.mkdir()
            publisher.write_text("raise AssertionError('remote publisher must not run')\n")
            PREVIEW.git("add", ".", cwd=repo)
            PREVIEW.git("commit", "-m", "Fixture", cwd=repo)
            PREVIEW.git("push", "origin", "HEAD:refs/heads/main", f"HEAD:{PREVIEW.BRANCH}", cwd=repo)

            gh = root / "gh"
            gh.write_text(
                "#!/bin/sh\n"
                'test -z "${FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON-}${GOOGLE_APPLICATION_CREDENTIALS-}"\n'
            )
            gh.chmod(0o700)
            hook = remote / "hooks/pre-receive"
            hook.write_text(
                "#!/bin/sh\n"
                'test -z "${FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON-}${GOOGLE_APPLICATION_CREDENTIALS-}" && '
                'test "${CATALOG_TEST_REJECT_PUSH-}" != yes\n'
            )
            hook.chmod(0o700)

            publisher.write_text(
                "from pathlib import Path\n"
                "import os, sys\n"
                "assert sys.argv[3:] == ['--apply', '--project', 'web-novel-viewer']\n"
                "assert os.environ['GOOGLE_APPLICATION_CREDENTIALS'] == 'fixture-credentials'\n"
                "Path(sys.argv[2]).write_bytes(Path('source.txt').read_bytes())\n"
                "raise SystemExit(1 if Path('reject-publish').exists() else 0)\n"
            )
            source = repo / "source.txt"
            source.write_text("published")
            reject_publish = repo / "reject-publish"
            reject_publish.touch()
            pending = repo / ".git/book-metadata-preview-pending.json"

            def tip(ref):
                return PREVIEW.git("rev-parse", ref, cwd=remote, capture=True).stdout.strip()

            original = tip(PREVIEW.BRANCH)
            with patch.object(PREVIEW, "ROOT", repo), patch.object(PREVIEW.shutil, "which", return_value=str(gh)), \
                 patch.object(PREVIEW, "wait_for_preview") as verify, \
                 patch.dict("os.environ", {"GOOGLE_APPLICATION_CREDENTIALS": "fixture-credentials",
                                           "FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON": "fixture",
                                           "CATALOG_TEST_REJECT_PUSH": "yes"}):
                with self.assertRaises(subprocess.CalledProcessError):
                    PREVIEW.run(preview_only=False)
                self.assertFalse(pending.exists())
                self.assertEqual(tip(PREVIEW.BRANCH), original)
                reject_publish.unlink()
                with self.assertRaises(subprocess.CalledProcessError):
                    PREVIEW.run(preview_only=False)
                self.assertEqual(pending.read_text(), "published")
                self.assertEqual(tip(PREVIEW.BRANCH), original)
                verify.assert_not_called()
                source.write_text("changed after Firestore publish")
                verify.side_effect = [RuntimeError("build failed"), None]
                with patch.dict("os.environ", {"CATALOG_TEST_REJECT_PUSH": "no"}):
                    with self.assertRaisesRegex(RuntimeError, "build failed"):
                        PREVIEW.run(preview_only=False)
                    self.assertEqual(pending.read_text(), "published")
                    commit = tip(PREVIEW.BRANCH)
                    PREVIEW.run(preview_only=False)
                self.assertEqual(tip(PREVIEW.BRANCH), commit)
                self.assertEqual(verify.call_count, 2)
                verify.assert_called_with(str(gh), commit)

            self.assertFalse(pending.exists())
            self.assertEqual(tip("refs/heads/main"), original)
            published = PREVIEW.git("show", f"{commit}:{PREVIEW.INDEX}", cwd=remote, capture=True)
            self.assertEqual(published.stdout, "published")
            committed = PREVIEW.git("diff-tree", "--no-commit-id", "--name-only", "-r", commit, cwd=remote, capture=True)
            self.assertEqual(committed.stdout.splitlines(), [PREVIEW.INDEX])
            self.assertEqual(index.read_text(), "old")

    def test_retries_status_errors_and_rejects_a_stale_preview_commit(self):
        failed_status = subprocess.CalledProcessError(1, ["gh", "api"])
        successful_status = SimpleNamespace(stdout="success\n")
        with patch.object(PREVIEW.subprocess, "run", side_effect=[failed_status, successful_status]) as status, \
             patch.object(PREVIEW, "git", return_value=SimpleNamespace(stdout="newer\trefs/heads/preview/mypage\n")), \
             patch.object(PREVIEW.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "프리뷰 브랜치가 변경"):
                PREVIEW.wait_for_preview("gh", "published")
            self.assertEqual(status.call_count, 2)


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
                "displayTitle": "첫 번째",
                "platforms": [{
                    "platform": "series",
                    "url": "https://series.example/1",
                    "coverUrl": "https://series.example/cover",
                    "downloadCount": 100,
                    "viewCount": None,
                }],
            },
            {
                "documentId": "f" * 64,
                "titleKey": "나",
                "displayTitle": "두 번째",
                "platforms": [
                    {
                        "platform": "series",
                        "url": "https://series.example/2",
                        "downloadCount": 300,
                        "viewCount": None,
                    },
                    {
                        "platform": "kakao",
                        "url": "https://kakao.example/2",
                        "coverUrl": "https://kakao.example/cover",
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

    def test_discovery_joins_deduplicates_and_hashes_projected_fields(self) -> None:
        self.aliases.append({**self.aliases[0], "documentId": "a" * 64})
        documents, manifest, _ = self.build("first")
        first = build_discovery(self.aliases, documents, manifest)
        self.assertEqual(set(first), {"schemaVersion", "generation", "genres", "tags", "books"})
        self.assertEqual(first["genres"], ["판타지", "현판"])
        self.assertEqual(first["tags"], ["성장", "하렘", "회귀"])
        self.assertEqual(first["books"][0], ["가", "첫 번째", "https://series.example/cover",
                         [["series", "https://series.example/1"]], 0, [1, 0], 2500, 100])
        self.assertEqual(first["books"][1], ["나", "두 번째", "https://kakao.example/cover",
                         [["series", "https://series.example/2"], ["kakao", "https://kakao.example/2"]],
                         1, [0, 2], 6250, 1000])
        self.assertNotIn("documentId", discovery_bytes(first).decode())
        self.assertNotIn("a" * 64, discovery_bytes(first).decode())
        later_docs, later_manifest, _ = self.build("later")
        self.assertEqual(discovery_bytes(first), discovery_bytes(build_discovery(self.aliases, later_docs, later_manifest)))
        for field, value in (("displayTitle", "다른 제목"),):
            self.aliases[1][field] = value
            changed = build_discovery(self.aliases, documents, manifest)
            self.assertNotEqual(first["generation"], changed["generation"])
            self.aliases[1][field] = "두 번째"
        for field, value in (("url", "https://series.example/new"), ("coverUrl", "https://series.example/new-cover")):
            platform = self.aliases[1]["platforms"][0]
            old = platform.get(field)
            platform[field] = value
            self.assertNotEqual(first["generation"], build_discovery(self.aliases, documents, manifest)["generation"])
            if old is None:
                del platform[field]
            else:
                platform[field] = old

    def test_discovery_rejects_invalid_urls_and_incomplete_cli_modes(self) -> None:
        documents, manifest, _ = self.build("first")
        self.aliases[0]["platforms"][0]["url"] = "https://user:secret@example.com/"
        with self.assertRaises(ValueError):
            build_discovery(self.aliases, documents, manifest)
        for option in ("--skip-catalog", "--limit=1"):
            with self.subTest(option=option), patch.object(sys, "argv", ["publisher", "--discovery-output", "out", option]):
                with self.assertRaises(ValueError):
                    PUBLISHER.main()

    def test_cli_writes_discovery_and_reports_counts(self) -> None:
        self.connection.commit()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "index.json"
            output.write_text("old", encoding="utf-8")
            stdout = io.StringIO()
            with patch.object(sys, "argv", ["publisher", "--discovery-output", str(output)]), \
                 patch.object(PUBLISHER, "open_readonly", return_value=self.connection), \
                 patch.object(PUBLISHER, "require_schema"), \
                 patch.object(PUBLISHER, "build_documents", return_value=(self.aliases, 0)), \
                 patch.object(PUBLISHER, "bucket_documents", return_value=[]), \
                 patch.object(PUBLISHER, "load_genre_resolver", return_value=self.resolve_genre), \
                 redirect_stdout(stdout):
                self.assertEqual(PUBLISHER.main(), 0)
            data = output.read_bytes()
            result = json.loads(data)
            summary = json.loads(stdout.getvalue())["discoveryOutput"]
            self.assertEqual(summary["books"], 2)
            self.assertEqual(summary["bytes"], len(data))
            self.assertEqual(summary["generation"], result["generation"])
            self.assertEqual(list(Path(directory).iterdir()), [output])

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
