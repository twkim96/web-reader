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


def deployment_env() -> dict[str, str]:
    env = os.environ.copy()
    env.pop("FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON", None)
    env.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def git(*args: str, cwd: Path | None = None, capture: bool = False, check: bool = True, timeout: int | None = None):
    return subprocess.run(
        ["/usr/bin/git", *args], cwd=ROOT if cwd is None else cwd, check=check,
        stdout=subprocess.PIPE if capture else None, text=True, env=deployment_env(), timeout=timeout,
    )


def wait_for_preview(gh: str, commit: str) -> None:
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        try:
            result = subprocess.run(
                [gh, "api", f"repos/{GITHUB_REPO}/commits/{commit}/status", "--jq",
                 '.statuses[] | select(.context == "Vercel") | .state'],
                check=True, capture_output=True, text=True, timeout=30, env=deployment_env(),
            )
            state = result.stdout.strip()
            if state in ("failure", "error"):
                raise RuntimeError(f"Vercel 프리뷰 빌드 실패 ({commit[:8]}).")
            if state == "success":
                remote = git("ls-remote", "--exit-code", "origin", BRANCH, capture=True, timeout=30)
                if remote.stdout.strip().split("\t", 1)[0] != commit:
                    raise RuntimeError(f"배포 확인 중 프리뷰 브랜치가 변경됐습니다 ({commit[:8]}).")
                print(f"프리뷰 배포 완료 ({commit[:8]}) {PREVIEW_URL}/#mypage")
                return
        except subprocess.SubprocessError:
            print(f"배포 상태를 조회하지 못했습니다 ({commit[:8]}). 다시 확인합니다.", file=sys.stderr)
        time.sleep(10)
    raise RuntimeError(f"제한 시간 안에 Vercel 프리뷰 배포를 확인하지 못했습니다 ({commit[:8]}).")


def generate_index(output: Path, *, preview_only: bool) -> None:
    project_args = [] if preview_only else ["--apply", "--project", "web-novel-viewer"]
    subprocess.run(
        [sys.executable, "-u", str(ROOT / "scripts/publish-book-metadata.py"),
         "--discovery-output", str(output), *project_args],
        cwd=ROOT, check=True, env=deployment_env() if preview_only else None,
    )


def update_preview(worktree: Path, source: Path) -> str:
    index = worktree / INDEX
    if index.resolve() != index or not index.is_file():
        raise RuntimeError(f"프리뷰 인덱스가 일반 파일이 아닙니다 ({INDEX}).")
    shutil.copyfile(source, index)
    changes = git("diff", "--quiet", "--", INDEX, cwd=worktree, check=False)
    if changes.returncode == 0:
        print("프리뷰 브랜치의 도서 탐색 인덱스와 동일합니다.")
    elif changes.returncode == 1:
        git("add", "--", INDEX, cwd=worktree)
        git("commit", "-m", "Refresh the public book discovery index", "--", INDEX, cwd=worktree)
    else:
        changes.check_returncode()
    commit = git("rev-parse", "HEAD", cwd=worktree, capture=True).stdout.strip()
    expected = git("hash-object", "--no-filters", str(source), cwd=worktree, capture=True).stdout.strip()
    actual = git("rev-parse", f"{commit}:{INDEX}", cwd=worktree, capture=True).stdout.strip()
    if actual != expected:
        raise RuntimeError("커밋의 탐색 인덱스가 게시된 파일과 다릅니다.")
    if changes.returncode == 1:
        git("push", "origin", f"HEAD:{BRANCH}", cwd=worktree)
        print("탐색 인덱스를 프리뷰 브랜치에 올렸습니다. Vercel 빌드를 확인합니다.")
    return commit


def run(preview_only: bool) -> None:
    gh = shutil.which("gh") or "/opt/homebrew/bin/gh"
    subprocess.run(
        [gh, "auth", "status", "--hostname", "github.com"], check=True,
        capture_output=True, timeout=30, env=deployment_env(),
    )
    common_dir = (ROOT / git("rev-parse", "--git-common-dir", capture=True).stdout.strip()).resolve()
    pending = common_dir / "book-metadata-preview-pending.json"
    with (common_dir / "book-metadata-preview.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("도서 메타데이터 게시가 이미 실행 중입니다.") from error

        git("fetch", "--no-tags", "origin", f"{BRANCH}:{TRACKING_REF}")
        base = git("rev-parse", TRACKING_REF, capture=True).stdout.strip()
        git("cat-file", "-e", f"{base}:{INDEX}")
        with tempfile.TemporaryDirectory(prefix="book-metadata-preview-", dir=common_dir) as directory:
            staging = Path(directory)
            worktree = staging / "preview"
            git("worktree", "add", "--detach", str(worktree), base)
            try:
                source = staging / "discovery.json"
                if pending.exists():
                    source = pending
                    print("이전에 Firestore에 게시한 인덱스로 프리뷰 배포를 재개합니다.")
                else:
                    generate_index(source, preview_only=preview_only)
                    if not preview_only:
                        source.replace(pending)
                        source = pending
                commit = update_preview(worktree, source)
                wait_for_preview(gh, commit)
                pending.unlink(missing_ok=True)
            finally:
                git("worktree", "remove", "--force", str(worktree), check=False)
                if pending.exists():
                    print("Firestore 게시 인덱스를 보관했습니다. 같은 버튼으로 프리뷰 배포를 재개할 수 있습니다.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview-only", action="store_true", help="Firestore 게시 없이 프리뷰 인덱스만 갱신")
    args = parser.parse_args()
    try:
        run(args.preview_only)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
