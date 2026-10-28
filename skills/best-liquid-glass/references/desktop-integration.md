# 桌面核心接入

复制 [assets/desktop-glass](../assets/desktop-glass/) 到目标项目，依赖 MSVC、Windows SDK 与系统图形库。Windows 10 2004+，C++20；已在 VS 2026 x64、SDK 10.0.26100 编译，SDK 路径自动发现。

## 构建与文件

```powershell
cmake -S desktop-glass -B build -A x64
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
```

生成 DLL/.lib、示例与测试程序。也可 `add_subdirectory(desktop-glass)` 并链接 `DesktopGlass`，把 DLL 放到宿主 EXE 旁。示例/测试开关为 `DESKTOP_GLASS_BUILD_EXAMPLE` / `BUILD_TESTING`。

- `DesktopGlass.h`：C ABI，捕获源、参数、呈现与诊断。
- `DesktopGlass.cpp`：DXGI/WGC、ROI atlas、GPU 槽、DirectComposition。
- `GlassShader.h`：嵌入式 HLSL 与128字节常量布局，可独立迁移着色器。
- `examples/minimal.cpp`：Win32 宿主及鼠标调度。
- `tests/shader_smoke.cpp`：WARP 合成纹理测试，不启动桌面捕获。

## 宿主生命周期

```cpp
#include "DesktopGlass.h"
DG_Handle glass = nullptr;
DG_Parameters p{};
DG_DefaultParameters(&p);
// owner 是本线程有效的顶层 HWND，宽高为物理像素；每步检查 HRESULT。
HRESULT hr = DG_Create(owner, 280, 112, &glass);
// 宿主完成选屏后调用；FALSE 表示不扩展到邻屏。
hr = DG_SelectMonitor(glass, chosenMonitor, FALSE, TRUE);
// 每帧更新 dpi、鼠标与形变；x/y 为玻璃左上角物理屏幕坐标。
hr = DG_Render(glass, x, y, &p);
hr = DG_Present(glass);
// 先停调度并等待 Render 工作线程，再销毁。
hr = DG_Destroy(glass);
```

`S_OK` 表示本次提交/呈现成功，`S_FALSE` 表示无源帧、无空槽或未完成，等下帧再调，不忙等。失败用 `DG_LastError` 与 HRESULT 定位；统计由 `DG_GetStats` 获取。

Create、选源/清源、Present、SetVisible、Destroy 在 owner UI 线程；Render 可移到已初始化 COM 的工作线程，同一实例内部串行。销毁前停止全部调用，owner 的寿命覆盖实例。

屏幕原点、鼠标、形变和探针用物理像素；圆角、厚度、外扩和感应距离用 DIP，传 `dpi_scale`。负圆角表示胶囊。尺寸变化先销毁重建；移动或形变复用纹理。宿主设置 PerMonitorV2 DPI 感知，处理布局和输入坐标。

## 选源与前景

已有系统选择器可用 `DG_SetCaptureItem`，传显示器 `GraphicsCaptureItem` 的借用 IInspectable 指针及对应 HMONITOR，核心自行持有引用；此路线仅 WGC 且不扩屏。

玻璃是独立不可命中的合成窗口，放在 owner 后。覆盖于 owner 时宿主需透明背景，文字/按钮单独绘制；阴影由宿主绘制并调用 `DG_ExcludeWindowFromCapture`。`DG_SetVisible(FALSE)` 释放捕获会话，恢复时等待新帧；`DG_ClearSource` 清除选择。

亮度探针默认关闭。需要时设置 `probe_count` 1–4、局部 `probes[]` 和 `probe_interval`，从 stats 读取原始桌面亮度。前景文字不参与折射。

示例按 C 捕获当前屏，H/S 隐藏/恢复，拖控制窗移动旁边玻璃，Esc退出；锁屏释放、解锁按原选屏重建，失败间隔500ms重试。Electron 需原生桥；恢复约束见[方案](desktop-sampling.md)。
