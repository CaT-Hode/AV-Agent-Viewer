# 实现与接入

## 可迁移光学核心

将 `assets/` 四份 TS 一起复制到目标源码：`ray-optics.ts` 提供截面、折射与 overscan；`optics-model.ts` 生成圆角 SDF 法线、RG 位移、高光和遮罩；`optics.worker.ts` 执行生成；`optics-cache.ts` 管理共享请求和 lease。它们从项目核心提取，不带设置、IPC 或导航常量。生成依赖浏览器 module Worker、OffscreenCanvas 与 Blob URL；构建器须处理 worker URL，CSP 须允许对应资源。

```ts
import { requestGlassOptics, readGlassRadii } from './optics-cache';
import { glassCaptureOverscan } from './ray-optics';
const options = {
  width, height, // ResizeObserver 的局部 border-box，CSS px
  radii: readGlassRadii(getComputedStyle(host), width, height),
  density, bezelWidth: 24, strength: .82, profile: 'convex' as const,
  concave: false, glassThickness: 70, refractiveIndex: 1.5,
  overscan: glassCaptureOverscan(24, 70, 1.5, 'convex', .82, 0),
};
const lease = await requestGlassOptics(options, abort.signal);
// 无 lease 时呈现可读降级；新资源解码后再替换旧 lease。
// 当前表面被替换或卸载后执行 lease?.release()。
```

`lease.optics` 的 map、highlight、可选 centerMap 是 Blob URL。SVG filter 使用 sRGB、userSpaceOnUse，画布宽高为 width/height 加两侧 overscan；feImage 按此尺寸放置，feDisplacementMap 的 R/G 通道与 edgeScale 匹配。中心与边缘分层，ring 作为边缘 mask，centerClip 裁切中心；lens 额外使用 centerMap/centerScale。背景层向外扩 overscan，前景仍在原 border-box。DOM 背景可接 backdrop-filter；独立视图须提供真实采样图，不能让 filter 处理前景。

同几何请求共享任务，AbortSignal 取消过时消费者；异常返回降级，不在 UI 线程同步重算。缓存限制是参考预算，应随尺寸和密度评估；`glassOpticsCacheStats()` 不含浏览器全部 GPU 缓存。

在技能目录运行 `node scripts/sync-optics.mjs <AgentViewer仓库> --check` 校验资源与源码；检查差异后用 `--write` 同步。

## Electron 来源与项目预设

独立 WebContents 不共享 DOM backdrop。按实际窗口坐标截取有限 ROI，保留 sourceContentsId、导航身份、布局版本、采样原点与像素密度；丢弃过期回调。移动时更新采样坐标，同像素不重复编码发送。不能用缓存旧帧冒充当前来源。

AgentViewer 源码位于 `apps/desktop/src/`：renderer/components 的 LiquidGlassSurface/NavigationGlass 是应用适配层；renderer/lib 的 layout-frame、floating-hitboxes、use-selection-toolbar-motion 分别负责读写调度、避让、姿态；main/web-toolbar 与 backdrop-frame-hub 处理原生采样。迁移时对照当前源码，不整份复制其应用依赖。

当前项目全局折射模糊上限为 0px，调用方例外须同时指定 blur 与 blurLimit。翻译窗的 70%填充、1px模糊、36px折射边缘、32px圆角属于该窗口预设，不是通用规范。
