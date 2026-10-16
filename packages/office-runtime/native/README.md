# Windows Office 光栅适配器

适配器服务于内置 LibreOffice 工作进程，ABI 固定为 Windows x64 LibreOffice 26.8.1.1；不能用于任意系统 Office。

## 输出边界

该版本 Windows 的 `SetOutputSizePixelScaleOffsetAndLOKBuffer` 无法使用调用方缓冲区。适配器先调用原方法保留比例和原点，再通过导出方法分配 VirtualDevice、读取真实光栅输出。[实现](office-kit-windows.cpp)不改文档内容，也不猜测私有对象布局。

页面瓦片与窗口绘制分别校验尺寸、像素格式、alpha 及所属实例；旧窗口像素不能进入新会话。宿主维护选区与输入身份，适配器不承担文字范围识别或命令语义。

## 构建与缓存

`npm.cmd run build` 经[构建脚本](../../../scripts/build-office-kit-adapter.mjs)使用 vswhere 查找 MSVC x64，并按源码和编译条件校验缓存；运行发布包不需要编译器。

bootstrap seed 仅复用无文档的扩展注册及受限安装标记，不含字体、硬件等运行缓存。`warmup()` 等同 `start()`，完成 DLL/适配器、hook 和 UNO 通用服务初始化；当前没有按格式加载空文档、初始化文档渲染或生成首瓦片。hook 已覆盖多少字体初始化需 trace 确认，不能假定字体完全冷启动。

[ABI 声明](../src/kit-abi-source.ts)和 C++ 同时校验固定二进制身份、导出地址、指令前缀；不匹配即停止。引擎版本由[锁文件](../../../engines.lock.json)管理。

## 升级验收

升级引擎/ABI后重建适配器，检查真实页面及原生窗口像素，再验收 Writer、Calc、Impress 的输入、文字选区、组合输入、对话框、保存重开、导出及进程退出。仅通过编译或修改版本字符串不足以证明兼容。

本轮 inputState、原子 inspect、调度和检查点调整位于[Kit 工作进程](../src/kit-worker-source.ts)及核心。真实 Windows Kit 已通过 Writer/Calc/Impress 编辑、Chromium 组合输入、PPT 文字历史、保存重开和独立导出；1280×800 原生控件对话框已验证主题、键盘取消及表格保存。三格式导出验证期间源文件、DLL 和关键源码哈希一致，工作进程正常退出。

这些结论限于本轮小样本；Python 模拟测试、Chromium 组合输入和单次计时分别不能代替真实 Kit、系统拼音输入法及大文件性能基准。Writer 首次原生加载仍需继续优化。

后续先拆分 open 的排队、临时文件、`documentLoadWithOptions`、`initializeForRendering` 及状态返回计时，再评估空闲时按格式最小文档预热。OOXML 辅助模型异步化覆盖 JS 解析；已延后启用的原生语义投影覆盖阅读几何；两者都不能直接消除未分段的原生导入、字体或排版成本。

[Office 会话与回执](../../../docs/office/README.md) · [开发](../../../docs/development/README.md)
