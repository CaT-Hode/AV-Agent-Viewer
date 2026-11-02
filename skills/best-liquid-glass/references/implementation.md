# 实现、性能与运动

路径相对apps/desktop/src/。

## 光学接入

assets 的 ray-optics.ts、optics-model.ts、optics.worker.ts、optics-cache.ts 一起迁移，不依赖 React。requestGlassOptics(options, signal)生成资源，readGlassRadii 读局部圆角，glassCaptureOverscan 算外扩；构建器/CSP支持 module Worker、OffscreenCanvas、Blob URL。map/highlight 解码后替换，用完 release，无 lease 不算折射成功。

SVG 用 sRGB、userSpaceOnUse；feImage 含双侧 overscan，RG 位移匹配 edgeScale。ring裁边、centerClip裁中心，lens接centerMap/centerScale。导航用border-box宽/map宽同步缩放，overscan左上同乘比例，实际border宽决定inset；宽度与光学同帧写。

## 性能与延迟

- renderer/lib/layout-frame 先集中读再写；use-selection-toolbar-motion 只在姿态变化时写 DOM，静止不重复写。
- LiquidGlassSurface 读未变形 border-box，签名排除纯呈现变量；同布局帧合并通知，直接查缓存、无固定等待。未命中交给 worker，新 key、离屏或卸载取消过时消费者，解码前后重验信号。导航变宽复用纹理，结束后下一布局帧更新。
- liquid-glass-optics 共享任务、取消过时消费者、保护活跃 lease。当前上限64项、解码64MiB、编码8MiB、待办12项；glassOpticsCacheStats 不含全部 GPU 缓存。
- optics-model 跳过中性内部像素；worker 每8行检查耗时，达到6ms让出消息循环。异常不在 UI 线程重算；
- main/backdrop-frame-hub 保留最新页帧；web-toolbar/backdrop-cache 按有效 ROI 和像素对齐采样，同图复用 PNG；发布前重验来源、导航、布局、滚动与缩放，丢弃旧帧。

分别测事件、布局、生成、解码、采样与呈现；rAF不等于硬件呈现，缩短动画不等于降低输入延迟。

## 弹性与形变

glass-elasticity 的 stepGlassSpring 解析步进覆盖欠/临界/过阻尼，dt限0–64ms，改目标保留值和速度。sampleGlassDragAxis 限定采样间隔和释放速度。拖动跟手，松手接续，不重播旧目标。

位置、scale/translate、填充/折射/放大和阴影分通道，仅更新当前 host 光学叶子。变宽按抓取原点补偿镜片，与填充对齐。显式滑块与委托面板不叠加。静止恢复 will-change、停 RAF，卸载撤销帧、监听和请求。

横速形变 sy=b×max(.7,1-|vx|/5000)、sx=b+1-sy；b为基础缩放，vx为px/s。速度平滑并闲置衰减，原点取抓取位置。高面板按 min(1,63/height)衰减形变。

glass-presets的位置1000/80、thumb形变2000/80、lens形变340/30为刚度/阻尼。侧栏从按钮布局框的方形种子双轴展开，退出逆向；同一弹簧驱动材质与位图，popup取种子/终态并集。

## 浮层所有权

MotionPresence 入场单 RAF，保留一个元素；SelectionTools 输入/错误共用下层，退出 inert。Portal 按 view/side 绑定，render 拒绝旧 host，cleanup 解绑关窗。TranslationBubble 更新来源只重置姿态/重画，不重建几何订阅；底图不重建ResizeObserver。障碍用全局hitbox；挤压保留宿主与viewId，完成退出，再入场。tooltip继承控件组。

## 同步

在技能目录运行 `node scripts/sync-optics.mjs <仓库> --check` 校验核心，`node scripts/build-buttons.mjs <仓库> --check` 校验原生按钮；检查差异后用 --write。全局模糊上限0px，例外同时传blur/blurLimit。选区2px，译文70%填充/1px模糊/36px边缘/32px圆角。导航亮度92转深、112转浅。
