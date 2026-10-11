"""把 addon 目录打包为可安装的 .xpi（本质是 zip，manifest.json 必须在根目录）。"""
import json
import os
import zipfile
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ADDON = ROOT / "addon"
DIST = ROOT / "dist"

manifest = json.loads((ADDON / "manifest.json").read_text(encoding="utf-8"))
version = manifest.get("version", "0.0.0")

SKIP_SUFFIX = {".log", ".pyc", ".map"}
SKIP_NAMES = {".DS_Store", "Thumbs.db"}

DIST.mkdir(exist_ok=True)
out = DIST / f"paperpilot-{version}.xpi"
if out.exists():
    os.remove(out)

count = 0
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for path in sorted(ADDON.rglob("*")):
        if path.is_dir():
            z.writestr(path.relative_to(ADDON).as_posix() + '/', '')
            continue
        if path.name in SKIP_NAMES or path.suffix in SKIP_SUFFIX:
            continue
        arcname = path.relative_to(ADDON).as_posix()
        z.write(path, arcname)
        count += 1

# Zotero 按 manifest 的 update_url 检查更新；该文件随每个 Release 上传，指向本版 XPI。
zotero = manifest["applications"]["zotero"]
repo = "https://github.com/yihengli333-netizen/PaperPilot"
updates = {"addons": {zotero["id"]: {"updates": [{
    "version": version,
    "update_link": f"{repo}/releases/download/v{version}/{out.name}",
    "update_hash": "sha256:" + hashlib.sha256(out.read_bytes()).hexdigest(),
    "applications": {"zotero": {k: zotero[k] for k in ("strict_min_version", "strict_max_version")}},
}]}}}
(DIST / "updates.json").write_text(json.dumps(updates, indent=2), encoding="utf-8")

print(f"[PaperPilot] {out.name} ({count} 个文件, {out.stat().st_size / 1024:.1f} KB)")
print(f"[PaperPilot] 输出: {out}")
print(f"[PaperPilot] 更新清单: {DIST / 'updates.json'}（随 Release 一同上传）")
