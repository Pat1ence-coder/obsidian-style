# 样式源码

在此目录维护样式源码。生成文件请勿手工追加规则。

- tokens.css：共享字体、字号、颜色、间距变量。
- shell.css：Obsidian 界面变量、整窗平铺外壳、收起侧栏边缘悬停滑出与左侧功能区自动隐藏。
- controls.css：侧栏与按钮——功能区图标方块、侧栏视图切换、文件树（当前笔记低饱和浅底）、搜索框和主按钮。
- typography.css：屏幕正文和标题，含中英数字自动间距（text-autospace）与阅读段落段尾防孤字（text-wrap: pretty）；默认 16px，可跟随全局字号缩放。
- components.css：表格、代码、引用与公式。
- editor.css：CM6 最小适配，不改编辑器内部缩进和光标几何。
- figures.css：原生 figure Callout 单图、多列（grid-N）及一大多小（mosaic-left/right）排版。
- print.css：A4、20mm、100% 缩放的学术导出规范。
- materials.css：看板卡片外壳、白色内容面、按钮与徽标材质和交互过渡；带减少动态和透明度降级。
- workbench.css：写作工作台版式（含周度复盘与底部状态栏进度徽章）与插图弹窗，不包含文档内容样式。
- figure-tools.css：文档内插图悬停工具条、调整宽度手柄、移动手柄与拖动时的位置轮廓（插件样式，打印时隐藏）。
- blocks.css：[!diagram] 图解。
- annotations.css：手写标注（插件样式）：六个行外位置、宽屏左右页边布局与长连线、五种手绘箭头（双线 / 虚线 / 实线 / 波浪 / 螺旋）、多行让位与边缘微调、自测模糊遮罩、跨库标注中心侧栏、快速标注与标注汇总弹窗，以及打印防分页控制。
- glass.css：文档外观细化（等宽字体、暖琥珀链接与行内代码、圆角细框表格、无白衬底圆角图片），仅作用于屏幕。
- window-glass.css：整窗类纸底色与 macOS 半透明玻璃。未开启系统半透明时，插件开启“类纸底色与半透明玻璃”会铺整窗暖白象牙纸底与细纤维 SVG 纸纹；开启 Obsidian“半透明窗口”（is-translucent）时切换为单层薄雾防重影真透明（弹出窗口保持不透明，全项目零 backdrop-filter）；关闭开关时回退素白平铺。
- workbench-glass.css：看板外观，含便当格布局、指标卡光斑、趋势图与月度柱（插件样式）。
- reading-tools.css：滚动刻度尺、刻度尺旁标题、密集目录浮层、阅读位置菱形标记与角落装饰图（插件样式）。
- typing-motion.css：平滑光标打字动效（插件样式）：纯 2D 平移滑移与静止呼吸淡入淡出，无 3D 变换或 will-change，遵守减少动态与打印隐藏。
- library.css：素材库（插件样式）：搜索与主色/比例筛选、目录树与标签、瀑布流卡片、拖拽归档遮罩、大图预览与检视弹窗；面板窄于 560px 时目录树收成下拉框。

scripts/build.js 输出两个样式文件：dist/snippets/style.css 管理文档；dist/algorithm-workbench/styles.css 管理工作台、素材库、标注、刻度尺、插图工具与弹窗。两者共享同一份 tokens.css。figure 样式因此在文档样式启用时无需插件运行也能使用。

普通文档及 research 为 820px，experiment 为 1120px。正文宽度由这套规范显式管理，即使 Obsidian 的“缩减栏宽”关闭也生效。屏幕字体有意统一为系统无衬线；PDF 切换学术字体。旧的粗体换字体、标题全部居中与段落零间距规则已移除。
