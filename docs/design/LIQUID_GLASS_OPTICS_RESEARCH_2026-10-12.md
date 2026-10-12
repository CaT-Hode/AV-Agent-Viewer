# AgentViewer 导航胶囊的 Liquid Glass 光学研究

日期：2026-10-12。范围：导航材质、真实内容折射、动态采样及验收。本文为研究与实现依据，不声称 AgentViewer 已通过本文所有验收。

最新要求以 [kube.io Searchbox及整篇文章](https://kube.io/blog/liquid-glass-css-svg/#searchbox) 和作者源码为玻璃唯一参考。此前固定1px/8px/46px及其他技能/第三方材质方案已被替代；下文保留为历史研究记录，不能继续据此限制新模型。新实现采用Searchbox高度56、半径28、bezel27、厚度70、IOR1.5、refraction.7、blur1、高光.2/4，全部来自作者当前固定提交`bd091c537fd502f2d1d4d60817e6f05626508e6b`。具体源码、所有控件参数、编码计算及新版验收边界见[组件映射文档](./LIQUID_GLASS_COMPONENTS_2026-10-12.md)第9节。

## 1. 判断依据与结论

把玻璃做得可信，主要取决于边缘曲面与背景像素的对应关系、背景更新的及时性，以及清晰的前景控件。增加模糊和背景填充不能替代这些能力。

证据分为四层：

- **Apple 官方事实**：设计意图、lensing、适应背景和材质出现/消失的原则。
- **上游代码观察**：开源实现实际使用的滤镜、位移图和组件结构；它们不是 Apple 官方实现。
- **本项目代码观察**：并行改造中读取到的具体问题或改进；以对应文件的当前代码为准。
- **工程推断与参数建议**：下文的曲面近似、采样预算和验收值；需要在 AgentViewer 的 Electron/Chromium 版本中实测。

推荐方向是：**圆角矩形距离场 → 连续凸起边缘曲面 → 法线与折射方向 → 有上限的位移图 → 8px 边缘遮罩**。中心只做 1px 模糊；控件文字和图标作为独立清晰层。原生网页保持可信独立视图，但采样必须跟随实际视口，而不能长时间显示旧背景。

## 2. 一手来源比较

以下为简短机制比较；后续的 AgentViewer 设计是本项目的工程方案，不是逐段复述这些来源。

| 来源 | 已验证的机制或声明 | 可采用的部分 | 不能直接据此承诺的部分 |
| --- | --- | --- | --- |
| Apple WWDC25 | 官方将 lensing 作为核心视觉特征，强调背景适应及与运动结合；材质变化不只依赖普通淡入淡出 | 导航层定位、曲率相关折射、轻填充、光学强度变化、无障碍降级 | 官方没有公开 CSS/SVG 公式，也没有给出 1px/8px 参数或数学曲面 |
| kube.io 原创文章 | 从曲面高度与法线出发做简化折射，比较凸、凹和 lip 轮廓；明确其是近似演示 | 先设计曲面再生成位移场的方法，边缘法线连续性 | 不是完整光线追踪；文章的 SVG scale 解释需按 MDN 重新校准 |
| shuding/liquid-glass | SDF 与 smoothstep 生成坐标映射，Canvas 编码后用于 SVG 位移，直接作用于页面背景 | 小型可读原型、真实 DOM 背景取样路径、位移图生成管线 | 片段公式不等同 Snell 物理模型；演示脚本不能直接作为生命周期完整的生产组件 |
| rdev/liquid-glass-react | React 包装，多种位移模式，边缘/中心组合及 RGB 通道处理；shader 模式参考 shuding | 前景与背景分层、参数化组件、响应尺寸变化 | 默认强度/模糊/色散不符合阅读导航约束；静态 map 的适配不保证精确 8px 边缘 |

来源：[Apple — Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)、[kube.io — Liquid Glass in the Browser](https://kube.io/blog/liquid-glass-css-svg/)、[shuding 项目](https://github.com/shuding/liquid-glass)、[shuding 实际源码](https://github.com/shuding/liquid-glass/blob/main/liquid-glass.js)、[rdev 项目](https://github.com/rdev/liquid-glass-react)、[rdev 组件源码](https://github.com/rdev/liquid-glass-react/blob/master/src/index.tsx)、[rdev shader 源码](https://github.com/rdev/liquid-glass-react/blob/master/src/shader-utils.ts)。访问日期均为 2026-10-12；上述分支地址会随上游改变。

Apple 关于 Regular/Clear 及使用位置的说明应作为设计原则理解；用户指定的低填充阅读导航是一种自定义 Web 近似，不应对外称为 Apple 原生材质或官方 Clear 的严格复刻。

## 3. 凸透镜、单峰位移、水波与模糊的差别

| 模型 | 背景如何变化 | 阅读导航中的结果 |
| --- | --- | --- |
| 曲面驱动的凸起边缘 | 位移方向遵循边缘法线，幅度由局部坡度、折射率和厚度决定 | 背景直线沿边缘连续弯曲，四角和直边属于同一曲面 |
| 手工 sine hump | 直接令位移幅度在边缘带两端为零、中间最大 | 可作审美近似，但幅度没有厚度/法线推导；仅换个公式名不会变成物理模型 |
| 随机 turbulence/水波 | 相邻像素的方向与幅度不稳定，未必与胶囊几何相关 | 背景文字出现无规律扭动，更像水面；不适合长时间阅读工具 |
| 纯 blur | 只降低空间频率，没有按位置重新采样 | 可表现磨砂，无法给出边缘曲率或凸透镜的形状证据 |
| 整体放大背景图 | 全区域统一缩放，中心也改变尺寸 | 像放大镜或错误对齐的副本；与“中心清晰、只有边缘折射”冲突 |

**位移出现单峰本身不证明模型错误。** 由凸曲面追迹得到的位移也可能非单调。判断是否为曲面模型，应看其是否由连续高度场、法线、介质和追迹距离共同得到，而不是仅看输出曲线是否像一个峰。

Apple 没有公布其内部轮廓，不能将“凸 squircle 是 Apple 精确公式”列为官方事实。对本项目而言，选择凸圆弧或凸超椭圆倒角，是兼顾连续性与可读性的工程决定。

## 4. AgentViewer 的曲面近似方案

### 4.1 几何与坐标

使用胶囊的 CSS 像素尺寸和真实圆角半径生成圆角矩形有符号距离场 `sdf(p)`，内部为负。令：

```text
d = -sdf(p)                         // 到外边缘的向内距离
b = 8 CSS px                        // 折射带宽度
u = clamp(d / b, 0, 1)
inwardNormal = normalize(∇d)
```

`d >= b` 的中心保持零位移；胶囊外不绘制材质。弯曲方向由 `inwardNormal` 决定，不能分别用 x/y 的随机噪声伪造曲率。尺寸、圆角或 DPR 改变时重新生成对应 map；只改变滚动位置不需要重新生成几何 map。

### 4.2 从曲面到取样位移

可用连续凸起倒角作为起点，例如四次超椭圆的边缘高度近似。下式是工程曲面候选，不是 Apple 算法：

```text
f(u) = (1 - (1-u)^4)^(1/4)
height(d) = bevelHeight * f(u)
slope = d(height)/d(d)
α = atan(slope)
β = asin(sin(α) / indexOfRefraction)
travel = baseThickness + height(d)
m(d) = travel * tan(α - β)
displacement(p) = inwardNormal * min(m(d), maxDisplacement)
```

在极小 `u` 处使用有限 ε，避免导数数值溢出；接近内边界时连续收敛到零。`baseThickness`、倒角高度和截断值必须分别配置，避免把边缘宽度同时当作唯一厚度和视觉强度。

这是垂直入射、单次折射、平面背景的近似，没有模拟完整双表面折射、真实环境反射或真实色散。它提供的是有一致几何依据的 UI 取样场。需要更复杂模型时应通过 profile 接口替换，而非在 UI 组件里叠加未经校准的波纹。

绘制时使用的是**反向取样**：目标位置 `p` 从 `p + displacement(p)` 读取背景。凸起模型应通过网格校准确认取样朝向；仅凭“正 scale 看起来更强”无法确定凸/凹方向。

### 4.3 材质分层

```text
清晰前景层：按钮、图标、输入框、焦点轮廓
弱高光层：沿边缘法线/方向变化的细高光，不带 backdrop 子节点
轻 tint 层：背景色 alpha，不改变整棵导航的 opacity
边缘光学层：8px ring，实际背景位移，少量或零色散
中心光学层：实际背景，仅 1px blur
```

中心与边缘不能在同一像素上重复采样并混合两份不同位置的背景。ring 和中心内区应恰好互补，反走样只在亚像素边界发生；正文实际图案不应在连接处出现双影或细缝。

## 5. SVG 位移的数值校准

MDN 给出的实际采样关系是：

```text
P'(x,y) = P(x + S * (R(x,y) - 0.5),
            y + S * (G(x,y) - 0.5))
```

通道归一化范围是 `[0,1]`，因此**每个轴的最大绝对偏移是 `|S|/2`，不是 `|S|`**。两轴同时极值时向量长度可达 `|S|/√2`；“单轴偏移上限”和“向量长度上限”必须分开说明。颜色空间默认可能采用 linearRGB，应明确 `color-interpolation-filters="sRGB"`。[MDN — feDisplacementMap](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feDisplacementMap)

文章或演示中的“scale 等于最大偏移”不能作为本项目的公式。kube.io 的描述与上述公式存在倍数差异；采用其曲面思路时必须独立校准，不沿用未经验证的通道系数。

本项目编码约定建议是：

```text
R = 0.5 + dx / S
G = 0.5 + dy / S
A = 1
```

选择 `S` 时留出编码余量，限制的是实际 `dx/dy` 或实际向量长度。不得先把向量归一化成 `[-1,1]` 后不加说明地乘另一个视觉强度。

RG8 的 128 对应 `128/255`，并不等于精确的 0.5。例如 `S=16` 时中性量化误差约为 0.0314 CSS px；通常可接受，但中心应通过独立未位移层实现，不能声称量化的 RG8 中心数学上完全零偏移。位移图应全不透明；透明黑不是中性通道，会造成错误取样或插值边界。

校准样本使用已知的 1px 竖线、横线及编号方格，验证正负方向、每轴最大偏移和中心零位移。计算单元测试不能替代 Chromium 最终滤镜输出的像素检查。

## 6. BackdropRoot：为什么透明胶囊有时折射不到正文

CSS backdrop-filter 取样范围止于最近的 BackdropRoot。MDN 与 CSS Filter Effects 的相关说明包含祖先 `opacity < 1`、非 none 的 filter、mask/clip-path、backdrop-filter、混合模式，以及相关 will-change。它们可能改变子孙的实际取样边界。[MDN — backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter)、[CSS Filter Effects Level 2](https://drafts.csswg.org/filter-effects-2/#BackdropRoot)

此前导航将 `opacity = 1-progress` 放在整棵导航祖先上，导致 live 光学层只看到祖先内部的内容，正文可能被排除。这种失效不会由“computed style 中有 url(#filter)”证明不存在。

设计约束：

- 取样链上的导航祖先保持 `opacity:1`，不放 filter 或 `will-change:opacity`。
- 出现/消失优先改变 SVG scale、tint alpha、边缘高光和必要的位移；前景按钮可在独立兄弟层淡出。
- ring mask 放在实际执行取样/绘制的光学层本身，避免把 mask 包装到取样层的父节点。
- 控件前景不要成为被 filter 的子树，否则文字也会折射或发糊。
- 层叠上下文、BackdropRoot、原生 WebContentsView 是三种不同边界；不能用一个 z-index 或 isolation 属性解释所有问题。

并行改造中已观察到 `navigation-toolbar.css` 将祖先 opacity 改为 1。这是针对上述问题的修复方向；是否成功还要观察实际正文网格在完整与部分隐藏状态下的折射。

## 7. 文档 live 背景与原生网页背景

### 7.1 文档：直接取样已绘制的内容

Markdown、PDF canvas/textLayer、Office 视图以及本地 HTML 视图，应优先使用同一个导航组件里的 live backdrop 光学层，取样实际绘制结果。不得重新渲染一份假正文、截取文档内容当静态背景，或用无关纹理表现“折射”。

实际内容要延伸到胶囊下面。如果文档在胶囊高度处始终保留空白，光学层只能折射空白，看不出形态。可以保留合理的初始标题间距，但滚动后的正文应正常从胶囊后面经过，不新增整行遮罩。

本地 HTML 若位于 iframe 内，还需验证 iframe 合成层能被当前位置的 Chromium backdrop 路径取样；不能只在主 DOM 放一个格子就宣称 HTML 已通过。

### 7.2 原生网页：真实像素的时间与空间一致性

网页与可信导航属于独立 WebContentsView。主 renderer 的 CSS 不能自动采样另一个原生视图，所以需要独立背景传输。已有 `capturePage` 取得的是实际网页像素，但**400ms 周期采样只是时间上的快照近似**：滚动和视频变化期间，胶囊可能显示上一帧。它不是虚构图案，却也不能被宣传为实时同帧材质。

Electron 提供区域 capturePage，另有 offscreen rendering/共享纹理方向；它们分别用于截图或不同的渲染架构，不能直接假设现有可见网页 WebContentsView 已拥有可共享的同帧纹理。[Electron — webContents](https://www.electronjs.org/docs/latest/api/web-contents)、[Electron — Offscreen Rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)

近期可执行方案：

1. 可信主进程按明确 sourceContentsId 和 viewId 找到实际网页，不凭第一个可见 view 猜来源。
2. 样本包含 navigationId、layoutRevision、geometryRevision、scrollX/Y、sequence、capturedAt、CSS 大小、像素大小、密度和捕获原点。
3. 胶囊显示、视口滚动、页面布局变化、native bounds 改变时立即请求新样本；只有一个 capture 在途，完成后合并最新一次需要更新的请求。
4. 活动滚动期间以实测能承担的频率更新，目标起点为 20–30fps；静止时停高频采样，按页面更新和低频探测触发。目标不是已验证性能承诺。
5. 旧 navigation/layout/geometry 或 sequence 的结果不得覆盖新样本。相同 URL 的 SPA 和重新载入也要校验导航身份，不能只检查地址字符串。
6. 样本过旧时显示轻透明的真实底景或暂时降低折射，不能将旧正文冻结在胶囊中心。消失或切页即停采样；恢复时先取新样本。
7. 本机原始分辨率与 CSS 像素明确换算，禁止无说明的半宽缩放、拉伸及 `scale(1.12)`；overscan 大小与最大位移/blur 半径一起设计。

若 capture 延迟或 PNG/IPC 成本不能达到验收，应保留数据接口，另行验证 offscreen texture 架构。不能为了玻璃效果将应用控制接口注入不可信页面世界，或移除现有网页/应用的隔离边界。

### 7.3 统一组件的边界

`NavigationToolbar` 保留一份功能模块注册表和同一 `NavigationGlass` 材质。App 持有共同的导航 progress/duration；原生宿主只接收状态与真实样本，不独立计算另一套自动隐藏规则。

只有传入的背景源不同：文档为 live，原生网页为受版本约束的 sampled/未来 texture。按钮尺寸、8px 带宽、曲面 profile、前景样式、快捷键、主题和无障碍偏好一致。

## 8. 推荐参数及理由

以下是 AgentViewer 的初始参数，不是 Apple 标准值：

| 参数 | 推荐起点 | 限制与观察项 |
| --- | --- | --- |
| 中心 blur | 1 CSS px | 不再另叠旧 blur(24px) 或父级模糊 |
| 折射带 | 8 CSS px | 固定几何宽度；圆角同样按真实距离处理，不用百分比渐变代替 |
| 实际取样偏移 | 通常 2–4px；上限 4–6 CSS px | 足以使正文直线弯曲；明确向量上限，避免仅限制每轴 |
| profile | 凸超椭圆倒角 + 厚度 + Snell 近似 | 必须通过直线/角落样本；也保留凸圆弧替换接口 |
| 折射率 | 1.5 起点 | 工程材质参数；不能把任意增强值解释为真实物理玻璃 |
| 基础厚度/倒角高度 | 1.5–3px / 4–8px | 和带宽解耦；配合最大位移截断调校 |
| tint | 浅色约 3–6%；深色约 5–9% | 通过亮网页/暗网页上前景色适应保证可读，不用 65% 暗底遮盖正文 |
| saturation | 1.08–1.15 | 保留实际内容颜色，不形成蓝/紫整层染色 |
| 色散 | 默认 0 | 小字阅读优先；实验时限制在边缘约 0.1–0.25px |
| 高光 | 约 1px 细边，方向性弱高光 | 不用大面积白色梯度或重复厚描边制造塑料感 |
| 几何 map 分辨率 | DPR 对齐，适度上限 | 大小/CSS 坐标不能与像素尺寸混用；100/150/200% 缩放都验收 |
| 采样 overscan | 至少覆盖最大偏移与 blur 支持区 | 起点 8–12 CSS px；最终值通过边缘透明像素/裁切检查确定 |
| native 更新 | 事件驱动，活动目标 20–30fps | 实测端到端延迟；后台、隐藏或静止停止高频 |

低填充条件下，阅读导航前景可以独立做亮度适应，地址输入框可保留轻微局部衬底。不要以恢复整条深色底板作为适应白色网页的默认办法。

## 9. 本轮代码观察与验收优先级

研究过程中代码正在并行变化，以下用于追踪风险，不视为最终状态快照：

| 文件 | 观察到的变化/风险 | 必须补的证据 |
| --- | --- | --- |
| `renderer/components/NavigationGlass.tsx` | 初版 sin 位移已在向独立 profile 迁移；map 中性 RG 与 8px ring 单独管理 | map 编码和最终位移幅度；中心不受位移；角落无缝 |
| `renderer/lib/navigation-optics.ts` | 新增凸倒角近似及背景样本元数据设计 | 曲面函数边界、有限数值、实际上限、版本/坐标落实 |
| `renderer/navigation-toolbar.css` | 祖先 opacity 已向 1 修复 | partial progress 时仍折射实际文档；并非只有最终状态正确 |
| `renderer/navigation-glass.css` | 中心1px、边缘8px；早期浅色18%/深色65%填充仍偏重 | 低填充与亮暗正文前景对比；降低后不能反向抬高旧材质填充 |
| `main/web-toolbar.ts` | 已去掉半宽缩图并增加部分样本条件；周期采样400ms仍需要实时更新方案 | 同URL导航/滚动/SPA/缩放下样本及时且不串页 |

最低验收顺序：

1. 先使用编号网格与横/竖1px线验证光学方向、8px覆盖范围和中心原样。
2. 在 Markdown 正文、PDF canvas/textLayer、实际 Office 视图、本地 HTML iframe 和 native 网页逐个验证。空白首页不能作为折射成功证据。
3. 导航进度 0、0.25、0.5、0.75 和1都观察；背景折射不得因为祖先fade而突然消失。
4. native 连续滚动时录制含真实读区和胶囊的窗口合成结果，测量样本年龄与视觉拖影；只截 toolbar 自身或 browser_capture 看不到最终合成。
5. 验证页面重新载入、同URL SPA、侧栏动画、跨窗口、DPR/缩放和主题切换不使用旧几何或旧正文样本。
6. 验证地址草稿、Ctrl+L、hover/focus持有、向下/向上自动隐藏和native输入恢复。光学升级不能改变harness坐标目标。
7. glass off、高对比度、减少透明度关闭光学层；减少动效降低材质运动。前景可读与正常点击必须保留。

“已应用 SVG filter”“computed blur 为1px”“生成了 PNG map”属于实现证据；**正文线条沿8px边缘弯曲且中心保持对应，动态页更新跟上实际内容**才是视觉行为证据。

## 10. 本研究的实施决定

不直接安装第三方组件来覆盖导航。采用原创的小型 profile/map/宿主接口，在现有共同导航里使用；参照上游机制，保留来源记录。shuding 与 rdev 仓库标示 MIT；若后续复制实现代码应保留相应许可。kube.io 的文章作为研究引用，本方案不复制其整套示例代码。

下一实现闭环依次处理：曲面/数值校准 → BackdropRoot链 → 低填充与清晰前景 → native新鲜度/坐标 → 真实内容合成验收。增加随机纹理、加深背景色或加大模糊不能替代其中任何一步。

## 11. 技能候选的核验补记

本轮已找到文章作者的实际公开源码仓库：[kube/kube.io](https://github.com/kube/kube.io)。在只读快照`bd091c537fd502f2d1d4d60817e6f05626508e6b`的完整Git树中未发现`SKILL.md`或LICENSE/LICENCE/COPYING，package.json也未标示license。当前不能称其发布了官方Liquid Glass技能，或将公开源码自行标成MIT。

| 候选 | 已核验的事实 | 本轮处理 |
| --- | --- | --- |
| [LeonardSEO/liquid-glass-react 的 liquid-glass skill](https://github.com/LeonardSEO/liquid-glass-react/tree/main/skills/liquid-glass) | 第三方技能；读取的v2实际raw文件front matter已成功通过YAML解析 | 当前优先推荐的候选；未安装，也不称为kube或Apple官方 |
| [ViShEsHK2412/glass-ui](https://github.com/ViShEsHK2412/glass-ui) | 本轮读取的技能metadata解析失败，原因是description中的冒号未以引号包围 | 记录为需修正metadata后再评估的候选；未安装 |

“YAML有效”只确认元数据格式可解析，不等同于效果已复现、项目组件已验收或代码分发许可已确认。这些候选不替代作者TSX的参数研究与AgentViewer的共同光学实现。本轮没有安装第三方skill。
