# 开发说明

## 源码与产物

`src/main.js` 是插件入口，本地模块由 `scripts/build.js` 打包。Obsidian 和 CodeMirror API 由宿主提供，不随插件打包。

样式统一维护在 `src/styles/`。构建输出：

- `dist/algorithm-workbench/main.js`：插件代码。
- `dist/algorithm-workbench/styles.css`：工作台和弹窗样式，不内嵌图片。
- `dist/algorithm-workbench/manifest.json`：插件元信息。
- `dist/snippets/style.css`：正文、编辑器、插图和打印样式。外框底色是纯色，不内嵌壁纸图片。

项目版本统一为 `0.0.1`，保存在根目录的 `package.json` 和 `manifest.json`。README 不固定版本号。最低 Obsidian 兼容版本不属于项目发布版本。

## 验证

在仓库根目录运行 `npm test`，会先构建再执行测试，避免误测旧产物。`node scripts/build-preview.js [recent|monthly]` 生成看板各视图的静态示例（演示数据覆盖六个月）；`node scripts/build-theme-preview.js` 生成使用 Obsidian 类名的外框示例，其中模拟宿主样式只是近似。构建只用 Node 标准库，没有图片素材需要生成。`npm run preview` 生成不含脚本的静态示例，不启动浏览器或服务器。`npm run stage` 从构建产物和 `examples/notes/` 准备预览库，已有配置不会被覆盖，也不会复制用户统计文件。

这些检查不替代真实 Obsidian 的加载、编辑器事件和视觉验收。当前没有引入下载依赖；旧浏览器及 PDF 验证工具仅在本地历史归档中保留。

构建和静态预览会在写入前校验固定输出路径，拒绝目录、目标文件及悬空符号链接。预览视图参数只接受 `board`、`recent`、`monthly`，省略时生成默认看板。预览库准备会先检查完整复制计划，包含示例源文件及递归子目录、运行文件、目标路径和初始化配置；发现链接时整体停止，不复制其指向的内容。目标限定在预览库目录内，创建目录、复制文件和初始化配置前会再次检查路径。不要将 `dist/`、`artifacts/preview/`、`sandbox-vault/` 或其中的输出文件链接到真实笔记库。

安装器在解析链接前检查源路径、目标目录、配置文件和备份目录，拒绝通过链接挂载的安装目录，避免从错误的笔记库读取启用状态。路径检查用于阻止既存的链接和路径穿越；运行期间不要让其他进程并发替换这些目录。`tests/script-security.test.js`、`tests/stage-preview.test.js` 和安装测试覆盖越界链接、悬空链接、私有内容复制、非法视图参数及拒绝操作前后的文件完整性。

## Git 与历史材料

提交源码、测试、脚本、示例、模板和维护文档。目前直接在仓库中分发四个构建文件：`dist/algorithm-workbench/` 下的 `main.js`、`manifest.json`、`styles.css`，以及 `dist/snippets/style.css`。源码变更后执行 `npm run build`，将对应产物与源码一起提交。`.gitignore` 仅放行这四个文件；其他构建目录内容（包括 `data.json`）、预览库、缓存、备份以及测试结果继续排除。

整理前的其余实验材料保存在本地 `artifacts/legacy-style-refactor/`，包括原始报告、历史版本记录、下载的测试运行环境和旧预览库。原始记录保持原样，不作为当前项目的版本声明或测试证据。该目录不属于干净克隆后的运行依赖。

开始新实现阶段前，建立带校验和的独立源码快照；快照放入忽略的 `backups/` 或仓库外，避免把数据文件和缓存加入源码提交。
