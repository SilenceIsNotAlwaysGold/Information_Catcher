# -*- coding: utf-8 -*-
"""部署清单守卫 —— deploy.sh 只 rsync 显式 BACKEND_FILES 清单（无整树同步）。

历史反复踩的坑：新增/改动一个被 api.main import 的后端模块，却忘了加进
deploy.sh 的 BACKEND_FILES → ./deploy.sh 后服务器缺该文件 → api.main import
崩 → 生产宕机（2026-05-18 v2 上线就因 19 个文件漏列差点宕机）。

本测试 import api.main，收集其实际加载的所有 `api.*` 子模块文件，断言每一个
都在 deploy.sh 的 BACKEND_FILES 里。下次再漏加新文件，CI/本地会立刻失败，
而不是等部署时炸生产。

跑：uv run pytest tests/test_deploy_manifest.py -v
"""
import re
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_DEPLOY = _REPO / "deploy.sh"


def _backend_files() -> set[str]:
    """解析 deploy.sh 里 BACKEND_FILES=( ... ) 的相对路径集合。"""
    txt = _DEPLOY.read_text(encoding="utf-8")
    m = re.search(r"BACKEND_FILES=\((.*?)\n\)", txt, re.S)
    assert m, "deploy.sh 里找不到 BACKEND_FILES=( ... ) 块"
    files: set[str] = set()
    for line in m.group(1).splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            files.add(line)
    return files


def test_api_main_imports_all_in_deploy_manifest():
    """api.main import 图里的每个 api 模块文件都必须在 BACKEND_FILES。"""
    import api.main  # noqa: F401  触发完整 import 图

    listed = _backend_files()
    missing: list[str] = []
    for name, mod in list(sys.modules.items()):
        if not name.startswith("api"):
            continue
        f = getattr(mod, "__file__", None)
        if not f:
            continue
        p = Path(f).resolve()
        try:
            rel = p.relative_to(_REPO).as_posix()
        except ValueError:
            continue
        if not rel.startswith("api/") or not rel.endswith(".py"):
            continue
        # __pycache__ / 测试不算
        if "__pycache__" in rel or rel.startswith("tests/"):
            continue
        if rel not in listed:
            missing.append(rel)

    assert not missing, (
        "以下被 api.main import 的后端模块不在 deploy.sh BACKEND_FILES，"
        "部署后服务器会缺文件、import 崩、生产宕机——请补进 deploy.sh：\n  "
        + "\n  ".join(sorted(missing))
    )


def test_deploy_manifest_no_dangling_entries():
    """BACKEND_FILES 里列的文件本地都应存在（防手滑写错路径，rsync 静默跳过）。"""
    missing = [
        f for f in _backend_files()
        if f.endswith(".py") or f.endswith(".toml")
        if not (_REPO / f).exists()
    ]
    assert not missing, "deploy.sh BACKEND_FILES 列了不存在的文件：\n  " + "\n  ".join(missing)
