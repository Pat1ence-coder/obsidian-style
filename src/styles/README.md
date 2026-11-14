# 样式源码

在此目录维护样式源码。生成文件请勿手工追加规则。

- tokens.css：共享字体、字号、颜色、间距变量。
- shell.css：Obsidian 界面变量与少量外壳适配。
- controls.css：侧栏与按钮——功能区图标方块、侧栏视图切换、文件树（当前笔记蓝色胶囊）、搜索框和主按钮。
- typography.css：屏幕正文和标题；默认 16px，可跟随全局字号缩放。
- components.css：表格、代码、引用与公式。
- editor.css：CM6 最小适配，不改编辑器内部缩进和光标几何。
- figures.css：原生 figure Callout 单图、多列（grid-N）及一大多小（mosaic-left/right）排版。
- print.css：A4、20mm、100% 缩放的学术导出规范。
- materials.css：看板卡片外壳、白色内容面、按钮与徽标材质和交互过渡；带减少动态和透明度降级。
- workbench.css：写作工作台版式与插图弹窗，不包含文档内容样式。
- figure-tools.css：文档内插图悬停工具条、调整宽度手柄、移动手柄与拖动时的位置轮廓（插件样式，打印时隐藏）。
- blocks.css：批注与 [!diagram] 图解。
- glass.css：文档外观细化（等宽字体、暖色代码与高亮、白色表格底板、图片卡片），仅作用于屏幕。
- workbench-glass.css：看板外观，含便当格布局、指标卡光斑、趋势图与月度柱（插件样式）。
- reading-tools.css：滚动刻度尺与角落装饰图（插件样式）。

scripts/build.js 输出两个样式文件：dist/snippets/style.css 管理文档；dist/algorithm-workbench/styles.css 只管理工作台与弹窗。两者共享同一份 tokens.css。figure 样式因此在文档样式启用时无需插件运行也能使用。

普通文档及 research 为 1000px，experiment 为 1120px。正文宽度由这套规范显式管理，即使 Obsidian 的“缩减栏宽”关闭也生效。屏幕字体有意统一为系统无衬线；PDF 切换学术字体。旧的粗体换字体、标题全部居中与段落零间距规则已移除。
