# Windows 桌面采样液态玻璃

可复制核心在 [assets/desktop-glass](../assets/desktop-glass/)，接口见 [DesktopGlass.h](../assets/desktop-glass/DesktopGlass.h)，构建与宿主接入见[接入说明](desktop-integration.md)。已剥离业务、WPF、D3D9 和登录依赖；各实例独立持有采样源。

## 捕获与坐标

`DesktopGlass.cpp` 的 `DxgiTile`、`WgcTile`、`Renderer::Render` 实现捕获。由宿主选择允许的显示器；默认仅选中屏，显式开启才拼接邻屏。优先 DXGI Desktop Duplication，失败回退 Windows.Graphics.Capture；旋转屏走 WGC，沿用系统权限和保护限制。自由线程双缓冲池保留最新帧，关闭帧前保持纹理有效。

主窗口和玻璃窗口排除自身捕获，宿主额外阴影窗口也要排除，避免递归反馈。鼠标单独传入。ROI 用物理屏幕坐标，支持负坐标；轮廓使用未变形局部尺寸，DIP 统一乘 DPI。默认外扩112 DIP建立 atlas，覆盖折射偏移与96 DIP周围采光，按屏幕边界裁剪拼接；增大感应或形变时相应扩大外扩。

## GPU 折射与呈现

桌面纹理 → atlas → `LightPS`/历史纹理 → `LensPS` → 三个 GPU 槽 → DirectComposition。全帧留在 GPU；探针默认关闭，开启后每约120提交帧回读4×1 float4（64B逻辑载荷），由 `probe_readback_bytes` 统计。探针仅采原始 atlas，文字颜色判断不受玻璃、条形填充和高光污染。

`GlassShader.h` 用可调圆角矩形 SDF 求法线、厚度导数和 Snell 折射；默认折射率1.5、强度.72，按 `p-normal*displacement*(127/255)*strength` 取样。折射必须产生几何位移，不能用模糊替代。前景、阴影及条形填充由宿主实现，局部模糊单独调节。

槽保存纹理对应的屏幕原点；`DG_Present` 在 UI 线程取最新完成帧，同次提交纹理和位置，避免旧图提前移动导致慢拖抖动；位置不变不重复 `SetWindowPos`。`S_FALSE` 表示未就绪，本帧跳过。核心不处理手势：宿主位置直接跟手，松手停在释放点；轮廓通过 `shape_x_px/shape_y_px/pressure` 独立回弹。

## 周围高光与颜色

`LightPS` 在48×24位置做四tap均值；10×1浮点历史纹理第0格存全局统计，另9格存3×3局部颜色/亮度。全部区域按距离及法线参与，避免高光仅限一侧。

全局60→20ms、颜色80→30ms均为 dt 滤波常数，并非等待；小变化慢滤，大变化快跟随。近黑抑制噪声，深色提升感应，浅色增加彩色能量；亮度与色彩增益分开。

`colorReflection` 用 `S=(max-min)/max(max,.001)`，权重 `smoothstep(.12,.70,S)`；低于12%饱和度不染色，70%达完整权重，系数再乘`.6+1.2*S`。保留采样色相、压低中性白、增强饱和度；深色轻微向等亮灰色回收。子表面可降低 `highlight_strength`。

鼠标先在屏幕坐标约25ms平滑，再按采样原点转局部坐标；10→160 DIP连续衰减，附加能量放在环境上限后，避免亮背景吞掉响应。

## 锁屏恢复与验证

锁屏/解锁会使桌面复制、WGC 帧池或 D3D 设备失效。宿主监听会话通知：锁屏停调度并等待工作线程，在 UI 线程释放合成窗口/实例；解锁重建实例，并重新获取原授权显示器，保留选屏范围。旧帧、光场和 Closed 捕获项不可复用；仅缓存与设备无关的着色器字节码，避免反复编译。创建、Render、Poll、Present 的临时错误都应进入有间隔的重建重试，不能让工作线程永久退出，也不能把 E_ACCESSDENIED 当作用户取消选屏。核心在完成查询前检查设备移除；Win32 示例已接 WTS 通知。WPF 可监听 SystemEvents.SessionSwitch 并转回 Dispatcher。

自带 WARP 合成纹理测试检查折射位移、透明轮廓、饱和度门槛和原始亮度探针，不捕获桌面。接入后另测真实边缘、慢拖/反向、两侧受光、鼠标、跨屏 DPI 及锁屏恢复。当前格式为 SDR BGRA8；硬件表现和 HDR 需单独验证，GPU 时间不等同输入到屏幕延迟。
