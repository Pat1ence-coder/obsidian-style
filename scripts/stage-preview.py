"""Stage test runtime files inside the sandbox vault only; never deploy to the real vault."""
from pathlib import Path
import shutil
import json

root = Path(__file__).resolve().parents[1]
source = root / 'dist'
sandbox = root / 'sandbox-vault'
config = sandbox / '.obsidian'
plugin = config / 'plugins' / 'algorithm-workbench'
snippets = config / 'snippets'


def checked(path, boundary):
    """Reject links (including dangling ones) before resolving any path."""
    relative = path.relative_to(boundary)
    current = boundary
    for part in (None, *relative.parts):
        if part is not None:
            current = current / part
        if current.is_symlink():
            raise ValueError('Symbolic links are not allowed: ' + str(current.relative_to(root)))
    try:
        path.resolve().relative_to(boundary)
    except ValueError:
        raise ValueError('Path escapes its allowed directory') from None
    return path


# Plan every copy first so even a link in the last sample aborts before writes.
copies = [(source / 'snippets' / 'style.css', snippets / 'style.css')]
for name in ('main.js', 'styles.css', 'manifest.json'):
    copies.append((source / 'algorithm-workbench' / name, plugin / name))


def sample_files(directory):
    checked(directory, root)
    for item in sorted(directory.iterdir()):
        checked(item, root)
        if item.is_dir():
            yield from sample_files(item)
        else:
            yield item


# Only authored sample notes and synthetic assets enter the preview vault.
samples = root / 'examples' / 'notes'
for item in sample_files(samples):
    copies.append((item, sandbox / item.relative_to(samples)))

settings = {
    'appearance.json': {'theme':'moonstone','baseFontSize':16,'enabledCssSnippets':['style']},
    'app.json': {'readableLineLength':True,'showInlineTitle':True,'attachmentFolderPath':'./附件','pdfExportSettings':{'includeName':False,'pageSize':'A4','landscape':False,'margin':'0','downscalePercent':100}},
    'community-plugins.json': ['algorithm-workbench'],
}
for src, destination in copies:
    if not checked(src, root).is_file():
        raise ValueError('Missing source file: ' + str(src.relative_to(root)))
    checked(destination, sandbox)
for name in settings:
    checked(config / name, sandbox)

for src, destination in copies:
    checked(src, root)
    checked(destination, sandbox)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, destination)

# Initialize this isolated vault once; never overwrite a later test session's settings.
def initial(name,data):
    file=checked(config/name, sandbox)
    if not file.exists():file.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
for name, data in settings.items():
    initial(name, data)
print('Test runtime staged at:', root / 'sandbox-vault')
print('Only the isolated vault was initialized; no real user data/settings were copied or changed.')
