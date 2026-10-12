# 统一导航胶囊与边缘折射

日期：2026-10-12。范围：Windows 桌面导航、滚动行为和主窗口布局。

## 共享实现

文档与网页均渲染 `NavigationToolbar`，共用布局、按钮、分隔线、输入框、玻璃层与隐藏进度。功能通过 contributions 注册表组合：

- 共通模块：后退、前进、刷新。
- Markdown/HTML：文档名、阅读/源码/分栏、撤销与保存。
- Office/PDF：文档名、当前可用的撤销与保存；不显示无效源码/分栏按钮。
- 网页：地址、阅读副本、原地翻译/恢复。

`WebToolbar` 仅保留可信原生视图的状态/IPC 适配，不再包含另一份导航控件 JSX。原生网页仍使用独立可信 WebContentsView；这属于宿主差异，不产生另一套导航组件。

## 光学参数

| 参数 | 实现值 |
| --- | --- |
| 中心高斯模糊 | **1px 上限** |
| 边缘抗锯齿模糊 | 0.4px |
| 折射作用范围 | 严格 8 CSS px 的圆角环 |
| 位移峰值 | 安全上限小于 6px；凸圆弧倒角、法线与单次 Snell 近似，SVG scale=16 |
| 背景 overscan | 四周 8 CSS px |
| 前景 | 文字/图标/输入框为独立层，无位移滤镜 |
| 底色不透明度 | 明亮内容 10%，暗内容 12%；未取到内容时使用主题降级值 |
| 边缘高光 | 与位移共用圆角法线，固定左上光源，局部弱高光 |

本地文档通过 SVG backdrop-filter 折射真实背景；原生网页通过完整分辨率背景采样使用相同位移图与参数。移除截图半宽降采样和 `scale(1.12)`；截图不保存、不发送模型。主题与控制尺寸共用，关闭玻璃/减少透明度/高对比度时禁用光学层和网页采样。

导航采样祖先保持 opacity=1，渐隐直接作用于光学层与前景模块，避免 BackdropRoot 阻断正文。HTML iframe 占满阅读视口，内部正文能滚到胶囊后。原生网页提供真实滚动与源变更事件，采样按实际胶囊几何、导航版本和源版本核对；单个在途抓取保留最新待采样请求。样本保留原窗口坐标，在胶囊动画中补偿位置；活动抓取以 32ms 间隔限流，400ms 为静止兜底而非实时帧率承诺。

采用 liquid-glass-frontend 技能的材质分层与主题规则；用户指定的低模糊参数覆盖技能默认的重模糊建议。

## 滚动规则

`useNavigationVisibility` 是两种宿主唯一的可见性控制器：

- 连续下滚累计 72 CSS px 才开始收起，之后 48px 对应完整隐藏。
- 根据滚动速度将插值时长调整为 96–220ms；高速不会跳过累计阈值。
- 上滚累计 16px 恢复，低于 2px 的抖动不反复切换。
- 停顿超过 400ms 重新累计；顶部 ≤16px 保持可见。
- 地址焦点与胶囊悬停保持显示，Ctrl+L 可立即恢复地址输入。
- 页面切换重置累计；其他位置保留设置中的闲置隐藏等待时间。
- 原生视图完成退出后实际隐藏；隐藏控件 inert 且不可点击。

主窗口常驻状态栏已移除。保存反馈使用轻提示；Agent 操作胶囊、任务与未保存提示按实际状态显示。设置窗口自身的保存反馈不属于阅读区状态栏。

## 验证

`npm.cmd run test:navigation` 包括滚动/凸面控制器单元测试、真实 Electron 导航/焦点/格式模块/无底栏测试，以及像素折射测试。校准测试用固定棋盘和细线背景比较 scale=16 与 scale=0；真实内容测试保留 Markdown 正文、PDF canvas 和 HTML iframe，在全显与部分收起状态下比较，覆盖 100%/150%/200% 显示缩放，检查中心/前景不位移、环内真实正文折射、圆角外不存在矩形遮罩。

回归保留 `test:motion` 的侧栏快速反转、目录跳转与窗口固定布局，以及 `ui-theme.e2e.ts` 的主题/无障碍降级、网页视图位置和地址焦点检查。

2026-10-12最终冻结构建`CmmBiUS3`完成：单元/核心31/31、ui-motion PASS、ui-glass-components PASS、真实正文18/18及固定图案6/6。对应证据目录分别为`agentviewer-motion-kB5pof`、`agentviewer-glass-components-0yK534`、`agentviewer-glass-content-ovi0Di`、`agentviewer-glass-optics-FW7ePK`（本机Temp目录）。真实控件确认switch/slider拖动各产生一个全局设置undo事务，透镜释放收敛并清理will-change；[组件映射与实际弹性](LIQUID_GLASS_COMPONENTS_2026-10-12.md)记录准确参数与检查范围。原生网页仍为实际像素采样合成；设置里的lens preview不代表文档Magnifier已交付。

该冻结构建随后完成`ui-navigation PASS`（`C:/Users/cth/AppData/Local/Temp/agentviewer-navigation-vdJHlt/evidence`）及`native-backdrop PASS`（`C:/Users/cth/AppData/Local/Temp/agentviewer-backdrop-uIKKlD/evidence`）。原生背景案例验证真实正文与滚轮采样新鲜度、150%像素密度、单个在途capture、reload和hover；保持上述采样合成的能力界限。
