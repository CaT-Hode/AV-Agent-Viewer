---
name: best-liquid-glass
description: Build or refine real refractive liquid glass in desktop web and Electron interfaces, including action/segmented buttons, rendering performance, input latency, interruptible springs and deformation. Use for glass materials and related interactions, not a general redesign or native GPU renderer.
---

# best-liquid-glass

从 AgentViewer 源码提炼材质、交互与优化机制。保留目标项目的布局、品牌和状态层，不为玻璃重做整站或强制换框架。

## 按任务取用

- 项目内复用 LiquidGlassSurface、NavigationGlass、GlassInteractionHost、GlassSegmentedControl 和原 CSS 顺序。
- 性能、延迟、弹性或形变任务，读[实现与优化](references/implementation.md)，先定位输入、布局、纹理、采样或呈现瓶颈。
- 新 DOM/SVG 项目可取用 assets 的四份 TS 光学核心；核心不带应用设置或 IPC，原生独立视图另接真实采样。

## 材质与几何

真实折射必须产生背景几何位移。前景控件与光学背景分层，材质 pointer-events:none；滤镜和材质透明度不作用于整段前景。普通按钮自身的按压缩放沿用原控制器，不叠加动画。

光学场使用局部 border-box 与真实圆角，屏幕坐标用于采样和避让；不能把已变形尺寸再当局部尺寸，造成双重缩放或命中错位。

深色取消重复宿主边框和常亮内白边，保留材质高光；选中填充与前景成对调整。减少动态效果时简化运动，高对比或减少透明度时保留可读状态和原生语义。

## 性能、延迟与运动

控件就绪后，按下反馈不等待纹理重建、截图、IPC 或业务回执；首次光学就绪单独计时。几何集中到同帧先读后写；静止不重复写 style。高频姿态优先命令式写 DOM，避免整树重渲染；位置 hook 的局部帧更新另测成本。

worker 可取消，同几何共享任务和有界缓存；解码后替换，旧 lease 用完再释放。移动与形变复用纹理，尺寸稳定后更新，避免逐帧重建位移图、模糊或截图。只保留最新有效底图，像素不变不重复编码。

弹簧改目标时从当前值和速度接手，直接拖动跟随指针，松手继承有界速度。位置、形变、材质分别调度，每个控件只有一个手势所有者；不要再套 CSS transition 或第二套弹簧。静止停 RAF、恢复临时 will-change；取消和卸载清理资源。

悬浮避让使用真实 hitbox 和所属组，自身 tooltip 不推走工具栏。障碍约束优先于弹性，只让声明可移动或收起的表面让位。退出立即 inert，几何刷新不能解锁。原生文字拖动的 pointercancel 不代表松手；控件取消、丢失捕获和失焦则按原组件回退。

## 两种按钮

- 操作 / 图标按钮共享原导航或选区材质，保留 disabled、焦点和可访问名称，不给每个图标重复生成纹理。
- 分段选择保留 radiogroup、aria-checked、游走焦点和方向键 / Home / End；填充与文字同步换色，镜片拖动，松开提交一次并消费随后 click。

[离线预览](assets/buttons.html) 直接编译项目原组件、样式、worker 和弹簧；折射失败不显示磨砂替代。生成和校验方法见实现参考。

## 验证

分冷/热状态记录排队、布局、生成、解码、采样和呈现。性能任务短交互每组至少100次，报告 P50/P95/最大值、帧间隔和长任务；检查慢拖、快速反向、缩放、取消及真实边缘位移。静止控件100帧核对 style 写入、纹理构建和编码增量，有意动画另计。

事件到下一帧只是调度代理；截图和 API 耗时不能证明真实键鼠到屏幕延迟或 FPS。说明证据范围，按改动验证，不为文档更新重跑无关整套 UI 测试。
