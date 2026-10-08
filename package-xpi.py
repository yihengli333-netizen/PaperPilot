"""把 addon 目录打包为可安装的 .xpi（本质是 zip，manifest.json 必须在根目录）。"""
import json
import os
import zipfile
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ADDON = ROOT / "addon"
DIST = ROOT / "dist"
for name in ['pdf_annotator.py', 'requirements.txt']:
    (ADDON / 'tools').mkdir(exist_ok=True)
    shutil.copyfile(ROOT / 'tools' / name, ADDON / 'tools' / name)

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

print(f"[PaperPilot] {out.name} ({count} 个文件, {out.stat().st_size / 1024:.1f} KB)")
print(f"[PaperPilot] 输出: {out}")
