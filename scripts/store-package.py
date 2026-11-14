"""Assemble submission files after pnpm build. Source input is restricted to tracked build inputs."""
from pathlib import Path
from hashlib import sha256
from shutil import copyfile
from subprocess import check_output
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text())['version']
output = root / 'build' / f'store-{version}'
output.mkdir(parents=True, exist_ok=True)
sources = check_output([
    'git', 'ls-files', '-z', '--', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
    'src', 'test', 'scripts/build.ts', 'scripts/svelte.ts', 'ui',
], cwd=root).decode().split('\0')
source_zip = output / 'firefox-source.zip'
with ZipFile(source_zip, 'w') as archive:
    inputs = {p: root / p for p in sources if p}
    inputs['README.md'] = root / 'store/reviewer.md'
    for name, path in sorted(inputs.items()):
        info = ZipInfo(name)
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes(), compress_type=ZIP_DEFLATED)

files = [source_zip]
for browser in ['chrome', 'firefox']:
    name = f'social-backup-{browser}.zip'
    with ZipFile(root / 'dist' / name) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        if manifest['version'] != version:
            raise ValueError('Build the current version first.')
    copyfile(root / 'dist' / name, output / name)
    files.append(output / name)
for name in ['store/listing.md', 'store/reviewer.md', 'store/archive.png', 'store/promo.png',
             'ui/icon-128.png', 'website/public/privacy.html']:
    destination = output / Path(name).name
    copyfile(root / name, destination)
    files.append(destination)
(output / 'SHA256SUMS').write_text(''.join(f'{sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in files))
print(output.name)
