"""Stage test runtime files inside the sandbox vault only; never deploy to the real vault."""
from pathlib import Path
import shutil
import json

root = Path(__file__).resolve().parents[1]
source = root / 'dist'
config = root / 'sandbox-vault' / '.obsidian'
plugin = config / 'plugins' / 'algorithm-workbench'
snippets = config / 'snippets'
plugin.mkdir(parents=True, exist_ok=True)
snippets.mkdir(parents=True, exist_ok=True)
shutil.copy2(source / 'snippets' / 'style.css', snippets / 'style.css')
for name in ('main.js', 'styles.css', 'manifest.json'):
    shutil.copy2(source / 'algorithm-workbench' / name, plugin / name)
# Only authored sample notes and synthetic assets enter the preview vault.
for item in (root/'examples/notes').iterdir():
    destination=root/'sandbox-vault'/item.name
    if item.is_dir():shutil.copytree(item,destination,dirs_exist_ok=True)
    else:shutil.copy2(item,destination)
# Initialize this isolated vault once; never overwrite a later test session's settings.
def initial(name,data):
    file=config/name
    if not file.exists():file.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
initial('appearance.json',{'theme':'moonstone','baseFontSize':16,'enabledCssSnippets':['style']})
initial('app.json',{'readableLineLength':True,'showInlineTitle':True,'attachmentFolderPath':'./附件','pdfExportSettings':{'includeName':False,'pageSize':'A4','landscape':False,'margin':'0','downscalePercent':100}})
initial('community-plugins.json',['algorithm-workbench'])
print('Test runtime staged at:', root / 'sandbox-vault')
print('Only the isolated vault was initialized; no real user data/settings were copied or changed.')
