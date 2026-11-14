# Obsidian Style

面向技术笔记的 Obsidian 文档样式与「算法工作台」插件：统一正文、公式、表格、插图和打印排版，提供「写作工作台」（多指标活跃统计、趋势图、年度热力图、月度汇总）、最近笔记及文件创建辅助功能。

## 开发

需要 Node.js 18 或以上；预览库准备和安装工具需要 Python 3。构建、单元测试和静态预览仅使用标准库，无需安装依赖。

```sh
npm test          # 自动构建，再运行测试
npm run build    # 生成插件和 CSS snippet
npm run preview  # 生成 artifacts/preview/workbench-static.html
npm run stage    # 准备独立的 sandbox-vault 预览库
```

静态预览使用合成数据和模拟的宿主 API；真实 Obsidian 的编辑器行为与视觉效果仍需在独立预览库中人工验收。

## 安装

仓库的 `dist/` 已包含可直接安装的构建文件。下载仓库 ZIP 并解压，或克隆仓库后，将 `dist/algorithm-workbench/` 中的三个文件放入笔记库的 `.obsidian/plugins/algorithm-workbench/`，在 Obsidian 中启用插件。将 `dist/snippets/style.css` 复制到 `.obsidian/snippets/`，在外观设置中启用。直接安装这些文件无需 Node.js 或 Python；修改源码后再执行构建。

更新已有插件时，先禁用插件，再使用安装工具。默认只预览；确认目标后加 `--apply` 执行：

```sh
python3 -B scripts/install.py --target /path/to/vault/.obsidian/plugins/algorithm-workbench
python3 -B scripts/install.py --target /path/to/vault/.obsidian/plugins/algorithm-workbench --apply
```

安装工具只更新运行文件，并备份已有安装；不会替换统计和设置文件 `data.json`。CSS snippet 需单独复制。

## 目录

- `src/`：插件功能、共享样式与必要图片资源。
- `tests/`：使用模拟宿主 API 的项目测试。
- `scripts/`：构建、安装、静态预览及预览库准备工具。
- `examples/notes/`：排版验收笔记与图片；`examples/templates/`：笔记模板。
- `docs/`：使用说明、样式规范和开发约定。
- `dist/`：仅提交三个插件运行文件和一个 CSS snippet，供直接下载安装。源码变更后重新构建并一并提交对应产物。
- `sandbox-vault/`：本地预览库；`artifacts/`：本地产物与历史归档。这两个目录不提交 Git。

详细说明见 [使用指南](docs/usage.md)、[样式规范](docs/style-spec.md) 和 [开发说明](docs/development.md)。

## 许可

见 [LICENSE](LICENSE)。
