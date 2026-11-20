#!/usr/bin/env python3
"""Publish the public book catalog and deploy its discovery index to the My Page preview."""

from __future__ import annotations

import argparse
import fcntl
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX = "public/catalog/discovery.v1.json"
BRANCH = "refs/heads/preview/mypage"
TRACKING_REF = "refs/remotes/origin/preview/mypage"
GITHUB_REPO = "twkim96/web-reader"
PREVIEW_URL = "https://twreader-git-preview-mypage-twkims-projects-b9c7f5a3.vercel.app"


def git(*args: str, cwd: Path = ROOT, capture: bool = False, check: bool = True):
    return subprocess.run(
        ["/usr/bin/git", *args], cwd=cwd, check=check,
        stdout=subprocess.PIPE if capture else None, text=True,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )


def wait_for_preview(gh: str, commit: str) -> None:
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        result = subprocess.run(
            [gh, "api", f"repos/{GITHUB_REPO}/commits/{commit}/status", "--jq",
             '.statuses[] | select(.context == "Vercel") | .state'],
            check=True, stdout=subprocess.PIPE, text=True, timeout=30,
        )
        state = result.stdout.strip()
        if state == "success":
            print(f"프리뷰 배포 완료 ({commit[:8]}) {PREVIEW_URL}/#mypage")
            return
        if state in ("failure", "error"):
            raise RuntimeError(f"Vercel 프리뷰 빌드 실패 ({commit[:8]}). Git 푸시는 완료됐습니다.")
        time.sleep(10)
    raise RuntimeError(f"Vercel 프리뷰 배포가 아직 완료되지 않았습니다 ({commit[:8]}). Git 푸시는 완료됐습니다.")


def update_preview(worktree: Path, *, preview_only: bool) -> str:
    project_args = [] if preview_only else ["--apply", "--project", "web-novel-viewer"]
    subprocess.run(
        [sys.executable, "-u", "scripts/publish-book-metadata.py", "--discovery-output", INDEX, *project_args],
        cwd=worktree, check=True,
    )

    changes = git("diff", "--quiet", "--", INDEX, cwd=worktree, check=False)
    if changes.returncode == 0:
        print("프리뷰 브랜치의 도서 탐색 인덱스와 동일합니다.")
    elif changes.returncode == 1:
        git("add", "--", INDEX, cwd=worktree)
        git("commit", "-m", "Refresh the public book discovery index", "--", INDEX, cwd=worktree)
        git("push", "origin", f"HEAD:{BRANCH}", cwd=worktree)
        print("탐색 인덱스를 프리뷰 브랜치에 올렸습니다. Vercel 빌드를 확인합니다.")
    else:
        changes.check_returncode()
    return git("rev-parse", "HEAD", cwd=worktree, capture=True).stdout.strip()


def run(preview_only: bool) -> None:
    gh = shutil.which("gh") or "/opt/homebrew/bin/gh"
    subprocess.run([gh, "auth", "status", "--hostname", "github.com"], check=True, capture_output=True, timeout=30)
    common_dir = git("rev-parse", "--git-common-dir", capture=True).stdout.strip()
    with (ROOT / common_dir / "book-metadata-preview.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("도서 메타데이터 게시가 이미 실행 중입니다.") from error
        git("fetch", "--no-tags", "origin", f"{BRANCH}:{TRACKING_REF}")
        base = git("rev-parse", TRACKING_REF, capture=True).stdout.strip()
        git("cat-file", "-e", f"{base}:{INDEX}")
        with tempfile.TemporaryDirectory(prefix="web-reader-metadata-") as directory:
            worktree = Path(directory) / "preview"
            git("worktree", "add", "--detach", str(worktree), base)
            try:
                commit = update_preview(worktree, preview_only=preview_only)
            finally:
                git("worktree", "remove", "--force", str(worktree), check=False)
        wait_for_preview(gh, commit)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview-only", action="store_true", help="Firestore 게시 없이 프리뷰 인덱스만 갱신")
    args = parser.parse_args()
    try:
        run(args.preview_only)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
