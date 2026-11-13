"""Stage test runtime files inside the sandbox vault only; never deploy to the real vault."""
from pathlib import Path
import shutil
import json
from safe_paths import checked_path, checked_tree

root = Path(__file__).resolve().parents[1]
source = root / 'dist'
sandbox = root / 'sandbox-vault'
config = sandbox / '.obsidian'
plugin = config / 'plugins' / 'algorithm-workbench'
snippets = config / 'snippets'
# Build and validate the complete copy plan before modifying the preview vault.
copies = [(source / 'snippets/style.css', snippets / 'style.css')]
copies += [(source / 'algorithm-workbench' / name, plugin / name)
           for name in ('main.js', 'styles.css', 'manifest.json')]
directories = [plugin, snippets]
examples = root / 'examples/notes'
for item in checked_tree(examples, root):
    destination = sandbox / item.relative_to(examples)
    if item.is_dir():
        directories.append(destination)
    else:
        copies.append((item, destination))
for src, dst in copies:
    checked_path(src, root)
    if not src.is_file():
        raise ValueError('Expected source file: ' + str(src))
    checked_path(dst, sandbox)
    if dst.exists() and not dst.is_file():
        raise ValueError('Expected destination file: ' + str(dst))
for directory in directories:
    checked_path(directory, sandbox)
    if directory.exists() and not directory.is_dir():
        raise ValueError('Expected directory: ' + str(directory))
for name in ('appearance.json', 'app.json', 'community-plugins.json'):
    checked_path(config / name, sandbox)
for directory in directories:
    checked_path(directory, sandbox)
    directory.mkdir(parents=True, exist_ok=True)
for src, dst in copies:
    checked_path(src, root)
    checked_path(dst, sandbox)
    shutil.copy2(src, dst)
# Initialize this isolated vault once; never overwrite a later test session's settings.
def initial(name,data):
    file=checked_path(config/name, sandbox)
    if not file.exists():file.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
initial('appearance.json',{'theme':'moonstone','baseFontSize':16,'enabledCssSnippets':['style']})
initial('app.json',{'readableLineLength':True,'showInlineTitle':True,'attachmentFolderPath':'./附件','pdfExportSettings':{'includeName':False,'pageSize':'A4','landscape':False,'margin':'0','downscalePercent':100}})
initial('community-plugins.json',['algorithm-workbench'])
print('Test runtime staged at:', root / 'sandbox-vault')
print('Only the isolated vault was initialized; no real user data/settings were copied or changed.')
