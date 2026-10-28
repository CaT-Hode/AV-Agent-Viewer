# 按变更验收

完整回归的旧清单、入口、测试源码及专用helper已退役。每轮先完成相关修改，再选择必要的真实桌面、引擎或协议场景；不恢复固定数量的通用矩阵。

## 构建与记录

```powershell
npm.cmd run build
node scripts/build-identity.mjs check
npm.cmd run docs:check
npm.cmd run mcp:budget
```

构建在`dist/build-info.json`记录buildId、版本、commit和关键产物时间／长度。验收结果记录对应buildId与实际范围，不把旧结果、替身或API读回表述为当前桌面通过，也不计算全量SHA。

## 必要场景

文档修改检查真实目标、局部读回和保存；涉及保存时确认实际文件可重开。视图变化检查当前文档、页面和选区不被迟到结果覆盖。浮层修复检查同一内容只有一个宿主、换文档后旧窗口退出、卸载清理命中区域。

性能任务区分事件、排队、执行、样式变化和呈现，保留分布与测量边界。组件或IPC采样不能证明物理键鼠到屏幕；不恢复已取消的系统输入法验收。

## 临时验收与数据

使用自己创建的TEMP profile和样本副本，不接管用户进程、配置或原件。非核心场景只做必要的针对性检查；通过后删除临时测试代码，保留JSON结果及必要截图。失败保留现场以定位原因，不修改golden或期望值掩盖问题。

当前交付结果放在`artifacts/verification/`，明确列出已验证与未验证范围。独立的`engines:verify`检查真实引擎可用性，MCP预算与发行认证继续各自执行。

[开发](development/README.md) · [性能](performance/README.md)
