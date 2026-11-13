# 开发说明

## 源码与产物

`src/main.js` 是插件入口，本地模块由 `scripts/build.js` 打包。Obsidian 和 CodeMirror API 由宿主提供，不随插件打包。

样式统一维护在 `src/styles/`。构建输出：

- `dist/algorithm-workbench/main.js`：插件代码。
- `dist/algorithm-workbench/styles.css`：工作台和弹窗样式，包含内嵌背景图。
- `dist/algorithm-workbench/manifest.json`：插件元信息。
- `dist/snippets/style.css`：正文、编辑器、插图和打印样式。

项目版本统一为 `0.0.1`，保存在根目录的 `package.json` 和 `manifest.json`。README 不固定版本号。最低 Obsidian 兼容版本不属于项目发布版本。

## 验证

在仓库根目录运行 `npm test`，会先构建再执行测试，避免误测旧产物。`npm run preview` 生成不含脚本的静态示例，不启动浏览器或服务器。`npm run stage` 从构建产物和 `examples/notes/` 准备预览库，已有配置不会被覆盖，也不会复制用户统计文件。

这些检查不替代真实 Obsidian 的加载、编辑器事件和视觉验收。当前没有引入下载依赖；旧浏览器及 PDF 验证工具仅在本地历史归档中保留。

预览库准备脚本在首次写入前检查全部复制来源、目标及配置路径，拒绝路径中的符号链接（包括悬空链接），并校验目标解析后仍位于预览库内。发现链接时直接退出，不会先复制部分文件。此检查针对已有链接；运行期间不应由其他进程并发替换这些目录。

## Git 与历史材料

提交源码、测试、脚本、示例、模板和维护文档。构建产物、预览库、缓存、备份以及测试结果均由 `.gitignore` 排除。发布时可将构建文件作为发布附件分发。

整理前的其余实验材料保存在本地 `artifacts/legacy-style-refactor/`，包括原始报告、历史版本记录、下载的测试运行环境和旧预览库。原始记录保持原样，不作为当前项目的版本声明或测试证据。该目录不属于干净克隆后的运行依赖。

开始新实现阶段前，建立带校验和的独立源码快照；快照放入忽略的 `backups/` 或仓库外，避免把数据文件和缓存加入源码提交。
