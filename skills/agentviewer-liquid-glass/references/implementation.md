# 实现、性能与运动

路径相对 `apps/desktop/src/`。数值是项目快照，不是 Apple 标准；以当前源码和用户要求为准。

## 光学接入

assets 的 ray-optics.ts、optics-model.ts、optics.worker.ts、optics-cache.ts 一起迁移，不要求 React。调用 requestGlassOptics(options, signal)，以 readGlassRadii 读局部圆角、glassCaptureOverscan 算外扩；构建器与 CSP 须支持 module Worker、OffscreenCanvas 和 Blob URL。map/highlight 解码后替换，用完 release；无 lease 不算折射成功。

SVG 使用 sRGB、userSpaceOnUse；feImage 尺寸含双侧 overscan，RG 位移与 edgeScale 匹配。ring 裁边缘、centerClip 裁中心，lens 另接 centerMap/centerScale。背景外扩，前景和命中尺寸不变。

## 性能与延迟

- renderer/lib/layout-frame 先集中读再写；use-selection-toolbar-motion 只在姿态变化时写 DOM，静止不重复写。避免交错读写和重复订阅。
- LiquidGlassSurface 使用未变形 border-box，几何签名排除纯呈现变量；导航尺寸动画复用纹理。首次生成和缓存命中不等80ms，已有纹理替换才合并重测，不能把它当输入防抖。
- liquid-glass-optics 共享任务、取消过时消费者、保护活跃 lease。当前上限64项、解码64MiB、编码8MiB、待办12项；glassOpticsCacheStats 不含全部 GPU 缓存。
- optics-model 跳过中性内部像素；worker 每8行检查耗时，达到6ms让出消息循环。异常不在 UI 线程重算；看 builds、pngEncodes、generatedPixels 和 pending 判断重建压力。
- main/backdrop-frame-hub 保留最新页帧；web-toolbar/backdrop-cache 按有效 ROI 和像素对齐采样，同图复用 PNG；发布前重验来源、导航、布局、滚动与缩放，丢弃旧帧。

拆开事件处理、主线程/布局等待、生成、解码、采样/IPC和合成呈现，统一时钟或对齐 trace。事件→rAF及合成回调接收时间不是硬件呈现时间，不能仅缩短动画时长便宣称延迟改善。

## 弹性与形变

renderer/lib/glass-elasticity 的 stepGlassSpring 对阻尼振子解析步进，覆盖欠/临界/过阻尼，dt限0–64ms；重定向保留值和速度。sampleGlassDragAxis 限定有效采样间隔和释放速度。直接拖动跟随实际位置，松手接续，不从旧目标重播 keyframes。

位置、scale/translate、填充/折射/放大和阴影分通道；只更新当前 host 的光学叶子。显式滑块与委托面板不能叠加。临时 will-change 在静止后恢复，达到容差即停 RAF；卸载撤销帧、监听和请求。

横向速度压缩 `sy=b×max(.7,1-|vx|/5000)`、`sx=b+1-sy`；b为基础缩放，vx单位px/s。速度平滑并随闲置衰减，原点取抓取位置。高面板按 `min(1,63/height)` 衰减形变，避免整页晃动。这是视觉近似，不是面积守恒。

glass-presets 的位置1000/80、thumb形变2000/80、lens形变340/30为刚度/阻尼，不能混为一组。1.2s收敛保护从最近输入重新计时，不截断持续拖动；位置hook另有1.5s保护。减少动态效果和取消沿用原控制器。

## 同步

在技能目录运行 `node scripts/sync-optics.mjs <仓库> --check` 校验核心，`node scripts/build-buttons.mjs <仓库> --check` 校验原生按钮；检查差异后用 --write。全局折射模糊上限0px，例外须同时传 blur 与 blurLimit。翻译窗70%填充、1px模糊、36px折射边缘、32px圆角仅属该窗预设。
