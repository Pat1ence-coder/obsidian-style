"""Preview or apply a runtime-only update. Never replace the plugin directory."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import json
import os
import shutil
import tempfile
import uuid

FILES = ('main.js', 'manifest.json', 'styles.css')
PLUGIN_ID = 'algorithm-workbench'


def atomic_write(path, content):
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.aw-update-', delete=False) as f:
            temp = Path(f.name)
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if temp is not None and temp.exists():
            temp.unlink()


def install(source, target, apply=False):
    source, target = Path(source).resolve(), Path(target).resolve()
    if target.name != PLUGIN_ID or target.parent.name != 'plugins':
        raise ValueError('目标必须是 plugins/algorithm-workbench。')
    if json.loads((source / 'manifest.json').read_text())['id'] != PLUGIN_ID:
        raise ValueError('源文件的插件 ID 不匹配。')
    payload = {name: (source / name).read_bytes() for name in FILES}
    if not all(payload.values()):
        raise ValueError('运行文件缺失或为空，请先构建。')
    for name in (*FILES, 'data.json'):
        if (target / name).is_symlink():
            raise ValueError('安装文件存在符号链接，已停止更新。')
    existing_manifest = target / 'manifest.json'
    if existing_manifest.exists() and json.loads(existing_manifest.read_text())['id'] != PLUGIN_ID:
        raise ValueError('目标目录包含其他插件，已停止更新。')
    result = {'target': str(target), 'files': list(FILES), 'data': 'preserved', 'applied': False}
    if not apply:
        return result
    enabled_path = target.parent.parent / 'community-plugins.json'
    if enabled_path.exists() and PLUGIN_ID in json.loads(enabled_path.read_text()):
        raise ValueError('请先在 Obsidian 中禁用算法工作台，再更新；完成后重新启用。')

    previous = {name: (target / name).read_bytes() if (target / name).exists() else None for name in FILES}
    backup = None
    if target.exists():
        # Outside the plugin directory, so replacing/removing that directory
        # does not also erase these recovery copies.
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = target.parent.parent / 'algorithm-workbench-backups' / (stamp + '-' + uuid.uuid4().hex[:8])
        backup.mkdir(parents=True)
        for name in (*FILES, 'data.json'):
            if (target / name).is_file():
                shutil.copy2(target / name, backup / name)
        result['backup'] = str(backup)

    target.mkdir(parents=True, exist_ok=True)
    written = []
    try:
        for name, content in payload.items():
            atomic_write(target / name, content)
            written.append(name)
        for name, content in payload.items():
            if (target / name).read_bytes() != content:
                raise IOError('安装校验失败：' + name)
    except Exception:
        for name in reversed(written):
            if previous[name] is None:
                (target / name).unlink()
            else:
                atomic_write(target / name, previous[name])
        raise
    result['applied'] = True
    return result


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    config = next((p for p in root.parents if p.name == '.obsidian'), None)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=root / 'dist' / 'algorithm-workbench')
    parser.add_argument('--target', type=Path, default=config / 'plugins' / PLUGIN_ID if config else None)
    parser.add_argument('--apply', action='store_true', help='执行更新；省略时只预览，不写入任何文件')
    args = parser.parse_args()
    if args.target is None:
        parser.error('未找到 .obsidian，请使用 --target 指定安装目录。')
    try:
        print(json.dumps(install(args.source, args.target, args.apply), ensure_ascii=False, indent=2))
    except Exception as error:
        parser.exit(1, str(error) + '\n')
