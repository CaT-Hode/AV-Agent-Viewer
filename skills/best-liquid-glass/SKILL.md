---
name: best-liquid-glass
description: Build real refractive liquid glass for desktop web, Electron and Windows desktop-sampling surfaces. Covers DOM materials, GPU capture/refraction, dynamic highlights, input latency and synchronized dragging. Not a general redesign.
---

# best-liquid-glass

复用 AgentViewer DOM/SVG 与 MIFY Quota 桌面采样的材质、交互和优化机制。保留布局、品牌和状态，不重做整站或换框架。

## 按任务取用

- 项目内复用 LiquidGlassSurface、NavigationGlass、GlassInteractionHost、GlassSegmentedControl 和原 CSS 顺序。
- DOM 性能、延迟、弹性或形变，读[实现与优化](references/implementation.md)，定位输入、布局、纹理、采样或呈现瓶颈。
- 新 DOM/SVG 项目取用 assets 的四份 TS 光学核心；核心不带应用设置或 IPC，独立视图另接采样。
- Windows GPU 桌面采样读[方案](references/desktop-sampling.md)和[接入](references/desktop-integration.md)，复制 assets/desktop-glass/。纹理与原点成对提交，位置跟手，形变独立回弹；纯网页需原生桥。

## 材质与几何

真实折射必须产生背景几何位移。前景控件与光学背景分层，材质不命中（DOM 用 pointer-events:none）；滤镜和透明度不作用于整段前景。按钮按压沿用原控制器，不叠加动画。

光学场使用未变形局部 border-box 与真实圆角，屏幕坐标用于采样和避让，防止双重缩放和命中错位。深色去掉重复边框和常亮内白边，保留材质高光；选中填充与前景成对调整。减少动态效果简化运动，高对比或减少透明度保留可读状态和原生语义。

## DOM 性能、延迟与生命周期

就绪控件的按下反馈不等待纹理、截图、IPC 或业务回执；首次光学就绪另计。几何同帧先读后写，静止不重复写 style；高频姿态命令式更新 DOM，避免整树重渲染。

几何按帧合并并直接查缓存，不加固定等待；未命中交给 worker，新目标取消过时任务。同几何共享有界缓存，解码后替换，旧 lease 用完释放。移动与形变复用纹理，只保留最新有效底图，像素不变不重复编码。

弹簧从当前值和速度接手，拖动跟随指针，松手继承有界速度。位置、形变、材质分别调度，每控件一个手势所有者，不再套 transition 或第二套弹簧。静止停 RAF、恢复临时 will-change，卸载撤销任务和监听。

初始姿态提交后下一 RAF 推进入场，不串联两帧空等。同一内容单一 presence，互斥输入/错误共用下层，退出立即 inert。跨窗 Portal 绑定视图和侧别，拒绝旧窗口、卸载释放；更新内容不重开宿主。

避让使用真实 hitbox 和所属组，自身 tooltip 不推走工具栏，不重复登记译文障碍。障碍约束优先于弹性，只让声明可移动/收起的表面让位。文字拖动的 pointercancel 不代表松手；取消、丢失捕获与失焦按原手势语义回退。

## 两种按钮

- 操作/图标按钮共享导航或选区材质，保留 disabled、焦点和可访问名称，不为每个图标重复生成纹理。
- 分段选择保留 radiogroup、aria-checked、游走焦点和方向键/Home/End；填充与透明镜片共用位置及宽度弹簧，切换平滑移动、拖动跟随，松开提交一次并消费随后 click。

[离线预览](assets/buttons.html)编译项目原组件、样式、worker 和弹簧；折射失败不显示磨砂替代。生成/校验见实现参考。

## 验证

冷/热状态拆开排队、布局、生成、解码、采样与呈现。性能任务短交互每组至少100次，报告 P50/P95/最大值、帧间隔及长任务；检查慢拖、反向、缩放、取消与真实边缘位移。静止100帧核对 style 写入、纹理构建和编码增量，有意动画另计。

事件到下一帧只是调度代理，截图/API耗时不能证明真实键鼠到屏幕延迟或 FPS。按改动验证，不为文档更新重跑无关 UI 测试。
