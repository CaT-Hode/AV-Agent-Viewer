# 紧凑开关、完整材质预览与提示同步修复

本轮需求覆盖此前“设置全部磨砂”的规则：布尔开关、多选分段和范围滑块，以及按需展开的材质预览均显式使用完整折射；普通面板、输入框、搜索和提示仍为磨砂。

## 开关

重新读取 [kube.io Switch](https://kube.io/blog/liquid-glass-css-svg/#switch) 与作者固定提交的 [Switch.tsx](https://github.com/kube/kube.io/blob/bd091c537fd502f2d1d4d60817e6f05626508e6b/app/data/articles/2025_10_04_liquid_glass_css_svg/graphics/Switch.tsx)。作者采用 lip 曲面、白色静止滑块、按压透明放大、位置与材质分别使用弹簧。现有共享光学引擎保留这些机制，尺寸按源比例缩至 42.5%，轨道实际 CSS 尺寸 68×28.475px，不再依赖 CSS zoom。

错位有两个来源：旧 `.setting-switch span` 会将所有内部 span 设为 16×16 白色圆点；同一元素上的独立 scale 和 transform translate 又让定位平移随 scale 改变。旧规则已排除新玻璃开关，定位改为独立 translate，与弹性 scale 分开。静止滑块两端与上下边距约 1.53px，实际横向行程 24.6075px；按压时允许作者式放大越出轨道，但中心保持对齐。

滑块显式使用完整 lip 折射。bezel 与厚度分别为源 19／47px 的等比值，折射率 1.5、高光 opacity 0.5／saturation 6；滑块透明度与折射强度随交互改变。静止填充白色与按压透明是作者原交互，不能将静止状态当作一颗浮在轨道外的小圆点。

多选分段的轨道／滑块缩至 36／28px，活动滑块使用作者 slider 的凸曲面、高光和材质弹簧。语言、主题、动画、协议和模型路由共用同一实现；长选项保持横向滚动，键盘导航仅滚动本轨道，不连带移动页面。范围滑块也启用完整折射。AI 阅读来源与 Excel 排序标题选项统一使用共享分段／布尔开关，保留选区、来源范围、设置撤销和文档事务语义。导航模式按钮共享所在导航胶囊的完整折射，不再嵌套一套背景采样。

Windows 150% 缩放时，1px CSS 边框实际取整为约 0.667px，固定 28px 滑块会比真实选项矮约 0.667px。滑块高度改为容器内尺寸减上下各 3px，保持不同像素密度下与选项同高、同中心；36／28px 为 100% 下的名义尺寸。

深色模式的带文字分段改为绿色玻璃选中底与白色文字，非活动轨道保持中性灰；与绿色轨道／白色滑块的布尔开关采用同一绿白语言。绿色略加深以保证小字号白字对比度，按压仍保留折射与材质变化；布尔开关的绿色与白色不跟随主题变成蓝灰。

文字分段采用三层：底部选中颜色、选项文字、最上方透明折射滑块。拖动时移动上层滑块，采样中包含实际下方文字；底部颜色在提交前保持原选项，松手后随选择弹性过渡。这样既保留绿白可读状态，又不会让玻璃只折射平坦轨道颜色。各层不拦截鼠标，拖动仍只提交一次设置事务。

绿色选中底保持纯色。文字分段取消 SVG 高光叠加与饱和度增强（`specularOpacity=0`、`specularSaturation=1`），保留上层镜片曲面的真实位移；其他玻璃材质的照明参数不受此单独要求影响。

## 材质预览

恢复 [Magnifying Glass](https://kube.io/blog/liquid-glass-css-svg/#magnifying-glass) 的凸曲面边缘与中央放大，使用完整 SVG 场、高光及速度相关形变。预览按需挂载，关闭详情后不常驻生成；拖动以布局位置和指针增量跟踪，避免缩放改变抓取偏移。普通设置面板不因此变成完整折射。

## 提示窗

框线／阴影与文字应在同一呈现层同步出现，磨砂材质保持稳定。位置按实际提示尺寸和控件锚点计算，使用约 7px 间距；视口边缘仅作必要夹取。Native 工具栏扩展透明空间时保持真实控件屏幕位置、正文采样与点击坐标不变，分别处理 CSS 坐标、DIP 和像素密度。

原生 Agent 胶囊扩展提示空间时，系统会在鼠标屏幕位置不变的情况下发出携带旧 CSS 坐标的 `pointerout/over`。仅当屏幕位置没有变化、视图补偿偏移发生变化且补偿后的点仍在原目标内时忽略该合成事件；真实移动、点击、滚动、失焦和 Escape 仍关闭提示，防止反复收起重开。

## 最低模糊与网页采样

完整折射材质的 Gaussian blur 统一限制为 **0px**，包括导航、Agent 操作胶囊、AI 结果浮窗、各类开关透镜和材质预览；SVG 的 Gaussian 阶段为恒等操作。边缘曲面与中央放大位移继续生效。普通磨砂面板与提示独立使用 CSS 磨砂，不受这一规则影响。Kube 的原始参数保留为参考数据，应用策略在共享材质层集中覆盖。

网页使用共享 `NativeBackdropFrameHub` 获取实际呈现帧，每个页面只启动一次订阅，导航、Agent 与 AI 结果同步裁切各自的小区域；不排队、不编码完整页面 PNG，每页只保留最新帧。窗口或消费者隐藏、最小化、关闭、禁用玻璃后释放订阅。变化区域才编码与传输，静态画面不重复发送图片；源提示先等待呈现帧，订阅不可用时回退截图。

Electron 44.7.0 的正常窗口订阅实现最大为 **30Hz**，不是 60Hz。原型在三个显示密度下观察到约 30 次/秒呈现回调，旧导航约 2.85 次/秒更新；这不等于最终业务显示帧率，集成结果另行验收。[官方实现](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/frame_subscriber.cc)

裁切使用窗口显示密度，独立于网页 zoom／DPR。150% 显示时将采样边界对齐 2 DIP、125%／175% 对齐 4 DIP，同时把实际区域写入缓存键、背景原点和元数据，避免半物理像素截图重采样。源导航、布局、内容、滚动、窗口尺寸和缩放均参与失效校验；晚到截图不能覆盖期间已接受的新呈现帧。

普通窗口的 `invalidate()` 不保证补发停止动画的最后一帧，因此仍保留 400ms 实际 `capturePage` 兜底。旧订阅帧不能覆盖已经接受的更新截图，截图路径保留单在途与最新请求。

## 验收

本轮以真实 Electron 中的滑块／轨道／材质层 boundingRect、绘制像素和截图验收，不再只看轨道尺寸与 aria 状态。控件先前已完成浅／深色、100%／150%／200% 几何验证；最终零模糊构建重跑 100% 完整控件审查与系统默认材质组件，并完成三种 DPI 的提示与网页采样。按压、直接跟手、提交／撤销、键盘、禁用及减少动效／透明度均保留验收。

冻结构建 `index-BA0Re3gi.js / index-mPpbsNOD.css` 已通过 51 项光学／缓存／坐标／动效／提示纯测试、21 项核心文档事务与保存测试。Tooltip 实际 100%／150%／200% 均通过，包含此前失败的 Agent 上方扩展与静止鼠标处理；三类真实控件、透明提示空间和当前正文采样保持坐标一致。

| 已完成的实际回归 | 证据 |
| --- | --- |
| 提示 100%／150%／200% | [100%](C:/Users/cth/AppData/Local/Temp/agentviewer-tooltip-09f3Xt/evidence/results.json)、[150%](C:/Users/cth/AppData/Local/Temp/agentviewer-tooltip-FlFnJd/evidence/results.json)、[200%](C:/Users/cth/AppData/Local/Temp/agentviewer-tooltip-G0u4nE/evidence/results.json) |
| 网页正文、滚轮、导航与采样像素 150% | [结果](C:/Users/cth/AppData/Local/Temp/agentviewer-backdrop-EpmlIc/evidence/sample-evidence.json) |
| 静态复用与 Office 传播 | [结果](C:/Users/cth/AppData/Local/Temp/agentviewer-rendering-performance-i1Veld/evidence/results.json) |
| 优雅弹性与展开收起 | [结果](C:/Users/cth/AppData/Local/Temp/agentviewer-elegant-motion-XWGE0F/evidence/results.json) |
| 单实例、设置存活与关闭草稿恢复 | [结果](C:/Users/cth/AppData/Local/Temp/agentviewer-startup-kC0iaS/evidence/startup-report.json) |
| 最终零模糊控件、实际文字折射与全设置审查 | [100% 完整结果](C:/Users/cth/AppData/Local/Temp/agentviewer-glass-switch-eE8wx9/evidence/results.json) |
| 真正光学预览、PDF 前景与交互撤销 | [结果](C:/Users/cth/AppData/Local/Temp/agentviewer-glass-components-6ZCJfy/evidence/results.json) |

静态页面实际截图 3 次后，PNG 编码、图片发送、全部 IPC 与光学资产生成均为零新增。Word、PPT、Excel 各经历 8 次上下文更新而正文渲染计数不增加；A1 实际编辑在 288 个可见单元格中只新增 4 次单元格渲染。动态源、滚动、新导航和布局改变的元数据与正文位图均逐像素一致。该静态回归不代表动态 GPU 帧率。

最终网页业务集成在导航、真实 AI 结果和 Agent 操作同时可见时，共享 **1 个页面订阅、3 个消费者**；动态过程中订阅没有反复重启。采样及实际 DOM 背景图片更新均约 30 次/秒（包含截图兜底发布，因此可略高于订阅上限）；三种显示缩放、三种网页 zoom 和三个消费者的 **27 组**区域全部逐像素一致。

| 显示缩放 | 导航／AI／Agent PNG 更新（次/秒） | 证据 |
| --- | --- | --- |
| 100% | 30.70／31.54／30.40 | [结果](C:/Users/cth/AppData/Local/Temp/agentviewer-frame-sampling-hUmweW/evidence/results.json) |
| 150% | 30.70／30.28／30.39 | [结果](C:/Users/cth/AppData/Local/Temp/agentviewer-frame-sampling-T6YRnS/evidence/results.json) |
| 200% | 30.07／30.16／30.14 | [结果](C:/Users/cth/AppData/Local/Temp/agentviewer-frame-sampling-H8jbji/evidence/results.json) |

通过真实抑制呈现回调验证了尾帧截图兜底；关闭 AI、Agent 过期、隐藏／最小化、禁用玻璃、切换文档均正确释放资源，恢复后重建唯一订阅。静态相同像素不增加 PNG 编码或图片发送，但 watchdog 仍执行实际截图，因此不是零 CPU。200% 下三个消费者约 3.5 秒累计 PNG 编码约 1,246ms，约每个源帧合计 11.76ms；照片页面、长期内存与最终 GPU 帧率没有由这一高对比 canvas 测试证明。

## 本机同步

本机 `C:/Users/cth/AppData/Local/Programs/AgentViewer` 已同步到上述冻结构建，19 个发布文件逐一校验 SHA-256。更新只涉及主进程、renderer、MCP 和插件文件，不覆盖设置、模型凭据、登录、引擎、依赖或原始文档；更新前保存了代码及原始 workspace 备份。

开始菜单已有 `AgentViewer.lnk` 启动成功；重复点击继续使用同一主 PID **22716**、同一可见窗口及服务。当前 renderer 上报的确认阅读上下文时间晚于该进程启动时间，验证了真实运行而非历史快照。当前磁盘 profile 的 4 个文档／4 个视图身份、模型与全部文档字节校验保持不变；实际安装版 MCP 提供 25 个接口及 11 个 AI 阅读工具，只读检查前后文档模型和字节不变。

此次恢复基准是更新前已退出应用的磁盘 profile（4 个文档、无未保存标记）。此前窗口曾有的 5 文档／1 草稿状态没有在现有恢复记录中找到，不把这次同步称为恢复了那个早先的未落盘状态。
