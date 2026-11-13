# 样式源码

在此目录维护样式源码。生成文件请勿手工追加规则。

- tokens.css：共享字体、字号、颜色、间距变量。
- shell.css：Obsidian 界面变量与少量外壳适配。
- typography.css：屏幕正文和标题；默认 16px，可跟随全局字号缩放。
- components.css：表格、代码、引用与公式。
- editor.css：CM6 最小适配，不改编辑器内部缩进和光标几何。
- figures.css：原生 figure Callout 单图及多图排版。
- print.css：A4、20mm、100% 缩放的学术导出规范。
- materials.css：工作台磨砂外壳、内容面、圆角和交互过渡；带无滤镜、减少动态和透明度降级。
- workbench.css：工作台与插图弹窗，不包含文档内容样式。

scripts/build.js 输出两个样式文件：dist/snippets/style.css 管理文档；dist/algorithm-workbench/styles.css 只管理工作台与弹窗。两者共享同一份 tokens.css。figure 样式因此在文档样式启用时无需插件运行也能使用。

普通文档及 research 为 1000px，experiment 为 1120px。正文宽度由这套规范显式管理，即使 Obsidian 的“缩减栏宽”关闭也生效。屏幕字体有意统一为系统无衬线；PDF 切换学术字体。旧的粗体换字体、标题全部居中与段落零间距规则已移除。
