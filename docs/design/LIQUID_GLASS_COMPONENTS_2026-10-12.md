# kube.io Liquid Glass 示例到 AgentViewer 的组件映射

> 后续修复：设置中的紧凑开关滑块与按需材质预览恢复完整折射，是普通设置磨砂规则的显式例外；旧深层 span 样式与定位缩放冲突一并修复。当前实现与验收见[开关与提示修复](SWITCH_TOOLTIP_REPAIR_2026-10-12.md)。下述记录保留前一轮范围。

> 当前材质范围：侧栏、普通设置面板、搜索、选区快捷条和悬浮提示采用轻量磨砂；统一导航、Agent 底部操作胶囊、右侧 AI 结果／选区译文小浮窗、布尔／分段／范围开关与按需材质透镜预览采用完整 Kube 折射。AI 抽屉本体保持磨砂。磨砂不生成光学地图／PNG／SVG；关闭的预览不挂载透镜。普通设置全部磨砂、预览磨砂卡片属于前一轮方案。最新控件和提示验收以[开关与提示修复](SWITCH_TOOLTIP_REPAIR_2026-10-12.md)为准，其余动效与性能记录见[交互更新](UI_POLISH_2026-10-12.md)和[性能记录](RENDERING_PERFORMANCE_2026-10-12.md)。

日期：2026-10-12。包含来源研究、组件目标及本轮实现/验证记录。第3/6节描述功能目标，第7/8.1节记录当前已接入并验证的范围；设置预览透镜仍不等同于文档局部放大工具。

当前要求以 kube.io 文章及作者固定提交的源码作为玻璃唯一参考，重新采用其具体曲面、参数与弹簧。此要求替代此前导航1px/8px/46px、小幅形变及其他技能的材质指导。共同玻璃引擎和共同导航继续保留；下文第7节和第8.1节是旧构建历史记录，不能作为本轮新实现的验收结果。最新实现见第9节。

## 1. 一手源码与证据范围

已读取 [参考页面](https://kube.io/blog/liquid-glass-css-svg/) 和作者 [kube/kube.io 仓库](https://github.com/kube/kube.io)。实际组件在文章目录下的 `graphics/`，滤镜由 `virtual:refractionFilter` 构建插件生成。公开构建 bundle 只用于最初确认页面结构，最终参数以作者 TSX 源码为准。

本次只读仓库快照为 `bd091c537fd502f2d1d4d60817e6f05626508e6b`。该快照完整树中未找到 `SKILL.md`，也未找到 LICENSE/LICENCE/COPYING；package.json 未标示 license。因此这不是作者发布的 Codex skill，公开可读源码也不能直接推定为 MIT。下文是机制与参数研究；AgentViewer 使用原创适配实现，后续若复制源码另核实授权。

作者项目中五个对应源文件：

- [Searchbox.tsx](https://github.com/kube/kube.io/blob/bd091c537fd502f2d1d4d60817e6f05626508e6b/app/data/articles/2025_10_04_liquid_glass_css_svg/graphics/Searchbox.tsx)
- [Switch.tsx](https://github.com/kube/kube.io/blob/bd091c537fd502f2d1d4d60817e6f05626508e6b/app/data/articles/2025_10_04_liquid_glass_css_svg/graphics/Switch.tsx)
- [Slider.tsx](https://github.com/kube/kube.io/blob/bd091c537fd502f2d1d4d60817e6f05626508e6b/app/data/articles/2025_10_04_liquid_glass_css_svg/graphics/Slider.tsx)
- [MagnifyingGlass.tsx](https://github.com/kube/kube.io/blob/bd091c537fd502f2d1d4d60817e6f05626508e6b/app/data/articles/2025_10_04_liquid_glass_css_svg/graphics/MagnifyingGlass.tsx)
- [MixedUI.tsx](https://github.com/kube/kube.io/blob/bd091c537fd502f2d1d4d60817e6f05626508e6b/app/data/articles/2025_10_04_liquid_glass_css_svg/graphics/MixedUI.tsx)

本轮没有执行作者示例、console 注入脚本或第三方安装脚本。第三方 liquid-glass 技能不是上述作者仓库提供的官方 skill。

## 2. 示例的具体差异

以下尺寸和参数是参考示例的默认值。本轮控件直接使用这些尺寸；导航采用Searchbox的高度和光学参数，宽度按实际工具内容生成。

| 示例 | 几何/profile | 默认光学参数 | 交互要点 |
| --- | --- | --- | --- |
| Searchbox | 420×56，r28；convex_squircle，bezel27，thickness70，IOR1.5 | specular .20；specular saturation4；refraction .70；blur1 | focus使尺度 .8→1；按压乘 .99；白色填充由 .05变为focus .20/press .30 |
| Switch | 轨道160×67；thumb146×92/r46；lip，bezel19，thickness47，IOR1.5 | specular .50；specular saturation6；refraction基准1；blur.2 | thumb .65→.9，填充1→.1；左右位置弹簧；拖动超过4px按中线决定状态 |
| Slider | 轨道330×14；thumb90×60/r30；convex_squircle，bezel16，thickness80，IOR1.45 | specular .40；specular saturation7；refraction基准1；blur0 | thumb .6→1，填充1→.1；轨道进度从玻璃下可见；dragMomentum false，elastic .02 |
| Magnifier | 210×150/r75；convex_squircle，bezel25，thickness110，IOR1.5；额外magnify map | specular .50；specular saturation9；refraction基准1；blur0 | 拖动时尺度 .8→1、refraction .8→1、magnifyingScale24→48；速度关联横纵形变；无拖动惯性 |
| Music Player / MixedUI | 搜索320×42；桌面底栏640×63；convex_squircle，IOR1.3 | specular .40；specular saturation6；refraction1；blur1；渐进blur强度1；填充.60 | 浮动搜索、滚动内容、底部胶囊；边缘阴影/渐进blur随滚动状态变化；卡片hover/press反馈 |

Searchbox/Switch/Slider 的形变不是给父节点设半透明度。它们分别改变 glass 的填充、折射强度、位置/尺度与阴影。Switch 的 lip 轮廓不同于另外几个凸曲面；Magnifier 的中央放大也是独立光学功能，不应作用于普通导航。

这里的 specular saturation 表示高光合成相关处理，不应直接等同于整份正文的 CSS saturation。位移参数仍须按 SVG 的 `channel - 0.5` 关系重新校准。

## 3. AgentViewer 的落地清单

### 3.1 Searchbox → 地址与真实搜索入口

映射位置是 `NavigationToolbar.AddressModule`、`SettingsApp.settings-search`、主页资源搜索和文档查找。

实现 `GlassSearchField`：独立背景光学层、清晰输入层、搜索图标、清除按钮、focus状态。输入/选区/IME仍由现有真实 input管理，不用截图重建可交互文字。

设计采用Searchbox原凸squircle曲面、27px bezel、70px厚度和IOR1.5。独立搜索保持作者 .8→1 的focus尺度、按压乘.99及原弹簧；导航保持56px宿主几何以对齐原生实际采样，focus/press采用作者填充.05/.20/.30。输入框宽度不随每个键改变；获取焦点不重建input或覆盖用户草稿URL。

导航地址不再在大玻璃胶囊内套一个完整有 backdrop-filter 的小玻璃。整个导航胶囊负责折射，地址只提供轻局部衬底和focus反馈；独立设置/主页搜索可以独立作为glass surface。

### 3.2 Switch → 设置中的真开关

映射位置是 `SettingsApp` 中的 `.setting-switch`，使用现有 `set(settingId, boolean)`、`role=switch` 与 `aria-checked`。

实现 `GlassSwitch` 的 track + 独立thumb。lip profile用在thumb，拇指按压/拖动时材质展开、填充变轻，使下方轨道状态可见；松开回到稳定状态。点击、Space/Enter、按中线结束拖动都只提交一次真实设置，不因为动画每帧写配置。

保留开启/关闭的清楚位置与对比，不仅依赖颜色。禁用开关不响应拖动、不会发请求；主进程拒绝设置时回到已确认值，不留下虚假“已开启”显示。指针移出、pointercancel、窗口失焦和切分类时释放拖动捕获。

本轮轨道直接使用160×67、thumb146×92/r46，rest尺度.65、active尺度.9，位移57.9px；设置行留出实际高度。地图按未缩放local几何生成，保持点击、键盘、拖动、取消和单次事务。

### 3.3 Slider → 有意义的连续值

当前设置数值主要用number input；优先为已经生效的 `appearance.leftWidth`、`appearance.rightWidth` 等连续布局值加入 `GlassSlider`，并保留可精确输入的数值框。阅读缩放/版心等尚未接入的能力先完成业务功能再增加滑杆。

thumb采用convex profile，active时透明并略展开，使已填轨道从下面透出。鼠标拖动本地即时预览，松开/键盘停止后提交一次或有限节流的真实值。范围、step与单位来自设置定义，不将模型并发、重试次数等所有数字机械换成滑杆。

保留Arrow/Home/End和aria-valuenow/min/max；track click直接跳转到对应值。重复输入、拖动离开边界或应用关闭不能造成监听器/RAF泄漏。

### 3.4 Magnifier → 局部阅读放大镜

映射到PDF、图片或细小图表的可选阅读工具，例如选区胶囊的“局部放大”。它是唯一允许中央放大的材质profile，默认不出现在导航/设置/正文卡片中。

拖动透镜时取样实际页面，边缘折射与中央放大分开。PDF canvas和textLayer都参与实际画面；玻璃不会修改PDF或生成新文档。关闭、Escape、切页或选区失效后撤销局部展示；工具自身不会丢失当前阅读位置。

仅透镜拖动柄接收拖动，避免大片透明框抢走正文选区。harness获得该工具的显示/位置/倍率能力时，目标仍绑定具体viewId和页面；agent实际点击/编辑时不能把经过视觉放大的坐标误当作原文坐标。

### 3.5 Music Player → 阅读器已有的组合界面

采用参考例的组合关系：内容独立滚动，上方小搜索、底部少量操作胶囊、清晰卡片，材质随交互和背景适应。

映射为主页最近文档/生成文档卡、AI工具抽屉/译文卡及底部Agent操作胶囊。卡片hover浮起、press压下，胶囊光学层保持与当前内容一致；不增加播放控件、音乐接口、封面下载或相册。

参考页面用大范围顶部/底部渐进blur强化演示。阅读页已经明确要求去掉导航下的矩形遮罩，所以不得原样复制整层blur带。渐进材质只能作用于浮动surface本身或抽屉内部的局部边界，不遮挡阅读器正文。参考填充.60也不套用到透明导航。

## 4. 共同引擎接口

新控件使用一个几何/光学实现，允许profile和强度贡献，不分别复制滤镜源码：

```text
GlassSurface
  geometry: actual width / height / radius / CSS-pixel band
  profile: convex / lip / magnifier
  source: live / versioned native sample / future texture
  optics: blur / refractionScale / specular / tint
  interaction: rest / hover / focus / press / drag / disabled
  accessibility: transparency / contrast / motion preferences
```

动画优先改变可插值强度、独立绘制层、位置与必要尺度。仅真实尺寸/profile改变时生成几何map；不能每个pointermove重新解析全滤镜或扫描整页截图。

被transform缩放的组件必须分清未缩放local box与最终screen bounds：生成map使用对应local几何，背景取样/原生位置采用最终screen geometry，不能把getBoundingClientRect宽度再交给同一CSS scale造成双重缩放。

导航功能模块仍统一注册，不因为材质不同产生网页/文档两套按钮与事件。所有设置开关和滑杆的业务状态沿现有SettingsService流转，不在玻璃引擎保存另一份配置。

## 5. 必须消除的祖先采样障碍

BackdropRoot会限制后代backdrop-filter的取样范围。针对项目现有结构，不能只添加越来越多的玻璃类。

| 现有位置 | 会出问题的做法 | 改造方式 |
| --- | --- | --- |
| `interaction-motion.css` 的 `[data-motion-surface]` | glass子节点的祖先在enter/exit opacity<1 | 祖先保持opacity1；淡出独立背景/高光和清晰前景层，或对单一surface本身执行效果 |
| `.motion-swap` / `.settings-content` | 分类动画整体opacity由.35变化，里面放需采样外部背景的开关/卡片 | 确认所需source：若只折射同级轨道可保留；若需外部背景则移除该祖先opacity，换位移/内部内容淡出 |
| 大pane：`.format-sidebar/.ai-drawer/.settings-nav/.home-sidebar` | 大pane自身backdrop-filter，里面每个search/button又独立折射同一页 | 选一个真实取样层：pane承担材质则内层用tint；独立控件需折射外部时取消pane过滤或放到独立兄弟surface |
| `.modal-backdrop` | modal的玻璃再试图穿过有backdrop-filter的遮罩看原文 | modal使用已处理的背景作为所需source；若要求原文直接折射，scrim只保留颜色并与modal光学层分开 |
| 胶囊/玻璃根上的 `filter / mask / clip-path` | 把采样层包在这些父节点下 | 将ring mask放到执行绘制的层本身；前景和高光为兄弟层；禁止父级opacity/will-change opacity |
| disabled/unavailable整行opacity | 子控件仍继续折射并接收输入 | 禁用业务输入；视觉改为foreground/tint状态，不靠整行半透明给可互动控件制造矛盾 |

这不是要求移除所有现有面板效果。它要求每个组件明确“要折射谁”：开关应首先折射自己的track；导航应折射正文；模态框可使用已弱化的背景。不同source的材质不能无意识地堆在同一条祖先链上。

## 6. 实施优先级和验收

1. 共同GlassSurface/profile支持动态圆角矩形，并通过正文直线样本检验真实折射。
2. 独立搜索与导航的地址focus/press；保持草稿、中文输入、选区与真实提交。
3. 设置GlassSwitch点击/键盘与状态；再实现拖动及取消/禁用/服务失败回退。
4. 已生效连续值的GlassSlider与精确数值输入；验证提交频率和跨窗口同步。
5. 主页卡片、抽屉/译文卡、Agent胶囊使用组合界面方案；无整行阅读遮罩。
6. 可选PDF/图表Magnifier；验证实际画面、页绑定和坐标体系。

共同验收包括100/150/200% Windows缩放、主题及透明度偏好、快速反转、键盘焦点、真实数据保存、跨窗口，以及live/native样本来源。截图必须包含实际内容和最终玻璃surface；静态背景纹理、旧正文样本和单独滤镜输出都不能代替验收。

作者示例中的移动端分支仅用于理解源代码，本项目本轮继续按桌面横版布局实施。

## 7. 本轮实现映射补记

以下记录当前实现与冻结构建`CmmBiUS3`的最终验证。第3节仍保留后续功能目标；当前设置中的演示透镜没有被宣称为所有文档格式的局部放大工具。

| 当前模块 | 接入范围 | 实现边界 |
| --- | --- | --- |
| `components/LiquidGlassSurface.tsx` | search、switch、slider、capsule、panel、button、tooltip、lens 共用材质入口 | live、native sample及fallback统一参数；前景与光学绘制分离 |
| `lib/liquid-glass-optics.ts` | convex/lip/lens profile、实际圆角与椭圆半径、位移map/ring/高光 | 按组件真实几何生成；不是只适用于导航的固定胶囊贴图 |
| `components/NavigationGlass.tsx` | 共同导航包装通用surface | 明确保留convex、blur1px、bezel8px；网页和文档共享导航形态 |
| `components/GlassControls.tsx` | 设置GlassSwitch和GlassRangeControl | switch拖动松开后提交一次布尔变化并抑制随后click重复提交；沿SettingsService进入全局设置undo |
| `SettingsApp.tsx` | leftWidth/rightWidth/toolbarDelayMs采用slider | 保留精确number input；其他数值不机械替换，仍按设置可用状态生效 |
| `components/GlassMaterialPreview.tsx` | 设置“外观与布局”中的可拖动透镜预览 | 取样场景里真实绘制的文字/线条，支持方向键；不改文档、阅读位置或用户设置 |
| `App.tsx / TooltipHost.tsx` | 搜索、面板、文档卡/按钮、提示等接入共同surface | native提示可走明确fallback；不把截图生成或父层blur当成已验收的实时正文折射 |
| `lib/glass-elasticity.ts / components/GlassInteractionHost.tsx` | 普通按钮、搜索focus、thumb和预览lens的共同弹性 | 解析阻尼弹簧步进、保留速度的重定向、有限RAF；不改业务click/input路径 |

真实Electron控件测试已经确认：一次switch拖动和一次左栏宽度slider连续拖动各使设置revision只增加1，全局设置undo分别恢复原值；透镜可拖动，释放后弹簧收敛并释放will-change，motion off下按压不形变。左右栏宽度与隐藏等待时间共用range控制器，保留精确输入；该测试的单次undo案例针对左栏宽度，不能推称全部设置组合及连接失败回退均已覆盖。

本轮验证记录：

| 检查 | 结果 | 本机证据目录 |
| --- | --- | --- |
| 单元/核心检查 | 31/31通过 | 冻结构建`CmmBiUS3`的本轮测试输出 |
| `ui-motion` | PASS | `C:\Users\cth\AppData\Local\Temp\agentviewer-motion-kB5pof` |
| `ui-glass-components` | PASS | `C:\Users\cth\AppData\Local\Temp\agentviewer-glass-components-0yK534` |
| `ui-navigation` | PASS | `C:\Users\cth\AppData\Local\Temp\agentviewer-navigation-vdJHlt\evidence` |
| `native-backdrop` | PASS | `C:\Users\cth\AppData\Local\Temp\agentviewer-backdrop-uIKKlD\evidence` |
| `ui-theme` | PASS | `artifacts/ui-theme`，主题、侧栏、设置undo、网页边界与滚动隐藏 |
| 真实正文光学检查 | 18/18通过 | `C:\Users\cth\AppData\Local\Temp\agentviewer-glass-content-ovi0Di` |
| 固定图案光学校准 | 6/6通过 | `C:\Users\cth\AppData\Local\Temp\agentviewer-glass-optics-FW7ePK` |

真实正文检查覆盖Markdown正文、PDF canvas/textLayer、本地HTML iframe在全显/部分收起及100%/150%/200%缩放下的背景折射；固定图案校准用于辨别中心、边缘及原生/本地宿主的位移。证据目录是本轮临时测试产物，不包含进Git的测试资源。

同一冻结构建的`ui-navigation`与`native-backdrop`也已通过。原生背景检查覆盖真实正文、滚轮采样新鲜度、150%像素密度、单个在途capture、重新载入及hover行为；这些结果验证当前采样链路，不将其升级为同帧纹理的承诺。

原生网页仍通过版本/几何受约束的实际页面capture样本绘制，属于采样合成，不是跨WebContentsView的原生同帧backdrop。当前preview lens只演示设置场景实际文字，文档Magnifier、全部格式页面和动态视频同帧折射仍是独立后续能力。

2026-10-12本机安装版已替换为冻结产物`CmmBiUS3`，main/renderer/mcp共14个构建文件与源码dist的SHA-256逐项一致。通过开始菜单重新启动后，已确认运行发现接口可读且根页面引用新renderer；沿用原用户数据目录与内置引擎。

同日修复启动可见性回归：先前隐藏方式启动留下后台单实例，旧second-instance仅focus无法显示hidden工作窗。现在提前注册激活监听，统一restore/show/focus；保留初始化期间激活请求，设置窗仍存在时可重建工作窗并重建其网页运行视图。`test:startup`使用真实单实例锁与独立临时profile验证隐藏/最小化唤醒、仅设置窗保留、四个并发启动及退出保存，均通过（`C:\Users\cth\AppData\Local\Temp\agentviewer-startup-8ZJ1gg\evidence\startup-report.json`）。本机仅更新主进程产物并以正常窗口方式启动，已确认窗口可见及重复快捷启动维持同一窗口；原4个文档/4个视图身份保留。

## 8. 作者点击与拖动弹性的准确参数

参数来自第1节所列固定SHA的四个TSX源码。下表是来源事实；后面的“小幅适配”是AgentViewer的实现决定。未执行第三方脚本。

| 示例 | spring stiffness / damping | 驱动值与函数 | 松手与拖动行为 |
| --- | --- | --- | --- |
| Searchbox | scale：800/40；填充：2000/80 | 尺度为`(focus ? 1 : .8) × (press ? .99 : 1)`；填充取pointer `.05→.30`、focus `.05→.20`的最大值 | focus/press状态变化后spring向新目标收敛；外层click聚焦真实input |
| Switch | 位置：1000/80；尺度与填充：2000/80 | thumb尺度`.65→.90`；填充`1→.10`；折射强度`(.4 + .5×active)×base` | 按压/拖动激活；拖动距离超过4px，松手以中线决定开关值；折射useSpring未显式指定参数 |
| Slider | 尺度与填充：2000/80 | thumb尺度`.60→1`；填充`1→.10`；折射`(.4 + .5×active)×base` | dragElastic=.02；dragMomentum=false；折射spring未显式指定参数 |
| Magnifier | 折射/中央映射强度：250/14；基础尺度：340/20；横纵形变：340/30 | 基础尺度`.8→1`，折射`.8→1`乘base；magnifyingScale`24→48`；纵向=`base × max(.7,1−abs(velocityX)/5000)`，横向=`base + (1−纵向)` | dragElastic=.13；dragMomentum=false；松手将velocityX设0，形变回归 |

来源中的`velocityX`是拖动事件提供的横向速度；横向形变是纵向压缩的补偿，不是独立循环波动。refraction/scale/alpha分别变化，不要将它们误合并成父节点opacity。

### 8.1 AgentViewer的实际弹性实现

当前`glass-elasticity.ts`采用解析阻尼振子步进，质量默认1，每次步进dt上限64ms；重定向保留当前位置与速度，不使用固定easing替代spring。

| preset | rest目标(scaleX/scaleY) | press基础目标 | stiffness / damping |
| --- | --- | --- | --- |
| button | 1 / 1 | 1.012 / .975 | 800 / 40 |
| thumb | .82 / .82 | 1.03 / 1.03 | 按压/键盘激活2000 / 80；释放1000 / 80 |
| lens | 1 / 1 | 1.04 / 1.04 | 340 / 20；pointer拖动速度绝对值之和超过40时damping为30 |

普通按钮保持小幅伸展/压缩；switch/slider展开thumb材质，固定轨道和命中布局不变。搜索focus使用lens preset轻微展开。拖动形变在基础目标上叠加，不把“速度增量上限”误写成最终绝对尺度上限：

```text
hx = clamp(abs(vx)/5000, 0, button?.025:.08)
hy = clamp(abs(vy)/5000, 0, button?.025:.08)
scaleX = baseX + hx - hy*.5
scaleY = baseY + hy - hx*.5
```

速度由pointer事件计算，最短时间差8ms，原始速度限±4000px/s，每次以.4系数低通；最后移动后按85ms时间常数衰减。装饰位移由`clamp(v/2000,-1,1)`乘button .45px、thumb .7px或lens 1.5px得到。它不替代真实thumb位置或透镜拖动坐标。

松手保留spring的当前速度并回rest；再次按下/反转重定向同一控制器。达到位置/速度容差即停止RAF并恢复will-change；最后输入后最多1200ms收敛兜底。拖动继续时更新兜底起点，不每1.2秒强行重置仍进行的手势。

`pointercancel`、捕获丢失、失焦、偏好变化和卸载都有结束/清理路径。reduced、off或OS减少动效关闭装饰spring，直接到rest；业务点击、键盘、值修改和focus保持原生路径。上述单元/控件验证已覆盖收敛、反转、关闭动效、真实拖动undo及透镜恢复；所有新场景仍按第6节扩展验收，不从这些结果推导全部交互已覆盖。

## 9. 最新需求：仅按作者模型和原默认值重做

2026-10-12重新通过`git ls-remote`确认作者main仍为`bd091c537fd502f2d1d4d60817e6f05626508e6b`，只读该提交的源码。没有安装技能、运行作者构建插件或复制整份无许可源码。原创实现位于`lib/glass-presets.ts`、`lib/navigation-optics.ts`、`lib/liquid-glass-optics.ts`、`LiquidGlassSurface`及共同elasticity控制器。

### 9.1 数值与滤镜

第2节的几何/光学默认值与第8节显式spring值现在是实现依据，取消第8.1节旧的小幅适配。MusicPanel准确参数是640×63/r31、bezel29、thickness90、IOR1.3；其搜索320×42/r21、bezel18、thickness100、IOR1.3。Switch轨道颜色为`#94949F77`/`#3BBF4EEE`，位置和颜色1000/80；Slider轨道为`#89898F66`/`#0377F7`。

径向场以128个样本计算。高度采用原convex_squircle；lip按原凸/凹高度和smootherstep方程混合，不能以余弦反向假装lip。法线差分步长为归一化坐标.0001，IOR从各preset读取；仅一次air→glass Snell折射，到`thickness + height×bezel`平面结束。边缘方向来自实际宿主圆角/椭圆的法线。

作者实际插件把位移向量除以固定100，编码为`128+vector/100×127`，并使用`max(abs(trace))×refractionRatio`作为SVG scale。它没有按文章叙述将地图归一化到max。因此本轮按实际组件代码外观实现，明确保留此固定100编码；不把SVG scale当成最终偏移像素，也不沿用旧6px位移cap。

滤镜顺序是magnifier可选中央map → Gaussian blur → edge displacement → saturation →以specular map裁出局部饱和区域 → alpha衰减高光 →两次normal blend。高光使用原pi/3方向、相反两侧光瓣与2px反光宽度；不把specularSaturation4/6/7/9应用于整份正文。

源码依据：[surfaceEquations](https://github.com/kube/kube.io/blob/bd091c537fd502f2d1d4d60817e6f05626508e6b/app/data/articles/2025_10_04_liquid_glass_css_svg/lib/surfaceEquations.ts)、[displacementMap](https://github.com/kube/kube.io/blob/bd091c537fd502f2d1d4d60817e6f05626508e6b/app/data/articles/2025_10_04_liquid_glass_css_svg/lib/displacementMap.ts)、[specular](https://github.com/kube/kube.io/blob/bd091c537fd502f2d1d4d60817e6f05626508e6b/app/data/articles/2025_10_04_liquid_glass_css_svg/lib/specular.ts)、[vitePlugin滤镜](https://github.com/kube/kube.io/blob/bd091c537fd502f2d1d4d60817e6f05626508e6b/app/data/articles/2025_10_04_liquid_glass_css_svg/vitePlugin.ts)。

### 9.2 应用宿主及真实采样

导航共享`NAVIGATION_METRICS`：height56、radius28、bezel27、thickness70、IOR1.5、blur1、refraction.7、specularOpacity.2、specularSaturation4。420是源示例宽度，阅读器按实际功能组宽度生成地图。shadowGutter16和captureOverscan26分开，透明原生宿主高度为88；采样范围为真实胶囊四周26px。

26px不是沿用旧固定边缘要求：Searchbox trace最大78.53294，按固定100/RG8/SVG计算实际最大21.50133px，取`ceil(shift + 3×blur + 1px AA)`得到26。其他组件按其preset独立推导采样余量。只在凸/凹边缘mask内过滤背景，前景按钮、输入和标签保留原DOM。中央普通区只blur；magnifier才使用24→48中央位移。

导航不整体scale，避免改变实际网页sample坐标和阅读操作命中范围；其press/focus采用作者fill .05/.20/.30和原spring。独立搜索使用原.8→1、press×.99。Switch与Slider分别按原thumb尺寸/尺度重做，保留单次设置事务。Magnifier使用210×150/r75与原横向速度/5000、纵向至少.7、横向补偿及各自spring/shadow。

祖先opacity、矩形遮罩及iframe视口问题的先前修复继续保留。普通文档用真实backdrop，原生网页用版本化实际capture，glass off/高对比/减少透明度使用可读fallback。没有用静态壁纸或模拟正文替换真实采样。

### 9.3 新版验证状态

相关纯单元测试17/17通过：原参数、Snell等介质/不同厚度、lip正负折射、真实capture余量、尺度和填充分离、magnifier补偿、弹簧重定向与关闭动效、滚动阈值。收起阈值仍为向下72px后48px渐隐、向上16px恢复；速度只调节380–650ms插值，idle650ms，focus立即恢复。

本节尚未报告新版构建/UI通过。旧CmmBiUS3的18/6像素用例是历史结果。新版需更新校准几何和filter scale到实际source模型，保留“实际正文不隐藏、前景不进入过滤层、外部无矩形遮罩”的断言，随后在整合后的同一冻结产物验收。
