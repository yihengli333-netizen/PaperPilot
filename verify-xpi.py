"""Validate the current version's package, resources, and source/build consistency."""
import hashlib
import json
import zipfile
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parent
manifest = json.loads((ROOT / 'addon/manifest.json').read_text(encoding='utf8'))
package = json.loads((ROOT / 'package.json').read_text(encoding='utf8'))
assert manifest['version'] == package['version'], 'Version mismatch'
# Zotero 10 ExtensionData.parseManifest rejects extensions missing any of these.
zotero_manifest = manifest.get('applications', {}).get('zotero', {})
for key in ['id', 'update_url', 'strict_max_version']:
    assert zotero_manifest.get(key), f'Zotero requires applications.zotero.{key}'
assert zotero_manifest['update_url'].startswith('https://'), 'Update URL must use HTTPS'
path = ROOT / 'dist' / f"paperpilot-{package['version']}.xpi"
required = [
    'manifest.json', 'bootstrap.js', 'defaults/preferences/prefs.js',
    'chrome/content/scripts/index.js', 'chrome/content/scripts/settings.js',
    'chrome/content/settings.xhtml', 'chrome/skin/icon.svg',
    'locale/', 'locale/en-US/', 'locale/zh-CN/',
    'locale/en-US/paperpilot.ftl', 'locale/zh-CN/paperpilot.ftl',
    'tools/pdf_annotator.py', 'tools/requirements.txt',
]
with zipfile.ZipFile(path) as archive:
    assert archive.testzip() is None, 'Corrupt ZIP entry'
    names = archive.namelist()
    assert len(names) == len(set(names)), 'Duplicate ZIP entry'
    assert all(name in names for name in required), 'Missing package resources'
    assert json.loads(archive.read('manifest.json')) == manifest
    for backend in ['pdf_annotator.py', 'requirements.txt']:
        assert archive.read('tools/' + backend) == (ROOT / 'tools' / backend).read_bytes(), 'Stale Python backend'
    assert not any('probe' in name or 'smoke' in name for name in names), 'Diagnostic code in release'
    for name in names:
        assert not name.startswith('/') and '..' not in Path(name).parts
        if name.endswith('/'):
            continue
        assert archive.read(name) == (ROOT / 'addon' / name).read_bytes(), f'Stale package file: {name}'
    for name in ['chrome/content/settings.xhtml', 'chrome/skin/icon.svg']:
        ElementTree.fromstring(archive.read(name))
    for locale in ['en-US', 'zh-CN']:
        ftl = archive.read(f'locale/{locale}/paperpilot.ftl').decode('utf8')
        assert 'paperpilot-section-sidenav =' in ftl
    assert f'"{package["version"]}"' in archive.read('chrome/content/scripts/index.js').decode('utf8')

report = {
    'file': str(path), 'version': package['version'],
    'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
    'result': 'Package structure, resources, versions, and addon bytes verified; desktop installation not tested',
}
(ROOT / 'dist' / f"verification-{package['version']}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps(report, ensure_ascii=False, indent=2))
