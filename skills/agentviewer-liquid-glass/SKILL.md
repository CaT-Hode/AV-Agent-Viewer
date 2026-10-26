---
name: agentviewer-liquid-glass
description: Build or refine real refractive liquid-glass surfaces in desktop web and Electron interfaces, including action and segmented buttons, optical layering, texture reuse, motion and floating controls. Use for glass materials and related interaction defects, not a general visual redesign or a native GPU renderer.
---

# AgentViewer 液态玻璃

从 AgentViewer 实际实现提炼真实折射材质与交互机制。保留目标项目的布局、品牌和既有状态层，不为使用玻璃强制增加彩色背景、换框架或重做整站。

## 按任务取用

- 在 AgentViewer 内修改，先查现有 `LiquidGlassSurface`、`NavigationGlass` 和材质样式，复用当前执行路径。
- 接入其他 DOM/SVG 项目或修改光学字段时，读[实现与接入](references/implementation.md)。`assets/` 提供四份可迁移 TypeScript 光学核心；它们不含完成的 UI 组件、Electron 截图或主题状态。按目标构建器接入 module worker，不强行引入 React。
- Electron 独立原生视图的背景采样、来源身份与项目预设，按需阅读同一参考中的对应段落。

## 材质与交互

前景文字、按钮、输入框与光学背景分层。材质层 `pointer-events:none`；光学滤镜和材质透明度只作用于背景。按钮自身按压缩放沿用项目控制器，不叠加第二套动画。真实折射须有背景几何位移；不可把半透明加模糊称为折射。

以局部 border-box 尺寸和真实圆角构造位移场；屏幕位置只用于背景采样与避让，不能把变换后的尺寸再当局部几何，造成双重缩放和点击错位。

几何变化合并处理，worker 生成、解码成功后切换纹理。移动与弹簧帧复用纹理，只更新最终姿态；静止停 RAF，不重复写 style、编码图片或触发 React 更新。过时请求取消，已借出的纹理在使用者释放前不能撤销。

拖动从当前姿态接手并保留速度，每个控件只由一个交互控制器驱动。悬浮避让使用实际 hitbox 和所属组；工具栏自身 tooltip 不反过来推走工具栏。只移动明确允许让位的表面。

退出表面立即 inert，几何刷新不能解锁。原生文字拖动的 `pointercancel` 不等于鼠标松开；保持抑制，等真实 mouseup、dragend 或失焦结束手势。

深色去掉重复宿主边框与常亮内白边，高光由材质产生；选中态分别控制底色与前景，避免与当前背景融为一体。减少动态效果时简化运动，减少透明度或高对比偏好下使用可读实底，保留键盘焦点和原控件语义。

## 验证

用文字或棋盘背景检查边缘实际位移及前景清晰度；在目标桌面运行时检查慢拖、快速反向、tooltip 悬浮、退出和重新出现。记录实际帧、样式写入、纹理构建与编码数量；静态截图和 API 耗时不能证明交互延迟。按修改范围验证，不为技能文档更新重跑无关全套 UI 测试。

## 两种按钮设计

- 操作 / 图标按钮：原生 button，保留 disabled、focus-visible、图标名称；普通前景按钮共享父级材质，按压即时反馈，不逐个创建折射纹理或叠加控制器。
- 分段选择按钮：radiogroup、aria-checked 与游走焦点，方向键 / Home / End 跳过禁用项。提交填充与选中文字同步变化，只有透明镜片移动；拖动松开提交一次，消费随后 click，捕获丢失或取消时复位。

[按钮预览](assets/buttons.html) 直接打包当前项目的 GlassInteractionHost、GlassSegmentedControl、LiquidGlassSurface、样式与 worker，启用真实折射，包含拖动、弹簧和键盘操作。按钮外观、参数和手势逻辑不另行实现；原生文字拖动与控件 pointercancel 分别处理。预览可离线打开，生成和校验方法见实现参考。
