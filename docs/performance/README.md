# 性能实现与验收

真实用户流程与局部诊断分开记录；均不推导未测范围的整体加速比例。

## 已实施

- Office轻量选区和原子inspect，人工applied与恢复检查点分离。Kit在屏障间优先交互、合并可替代读取，正在执行的调用仍不可抢占。
- MD/HTML显式轻量浮窗不携正文模型；冻结读保留来源，格式操作在Core本地构造。Markdown增量区块、可视装饰与巨行fragment限界减少全文回扫，保留原语法。
- 光学计算/编码移Worker；纹理预算64 MiB解码估算、8 MiB编码，稳定几何后更新，长任务期间降级材质。
- 恢复blob/delta最多32层，纯文本模型复用，备份清单及可达GC；metadata不重写正文。写队列64 MiB/8项、合并checkpoint、保序barrier及显式背压。
- 文本逆操作、历史/patch预算及提交后释放；工作区失效通知和revision缓存减少重复传输。

## 证据

Office以下为prewarm ready后的单次小文件，单位ms；非冷启动或P95。

| 格式 | 首次画布就绪/画面校验 | 重开画布就绪/画面校验 |
| --- | --- | --- |
| Word | 9068/9199 | 2890/2911 |
| Calc | 1984/2013 | 865/886 |
| PPT | 878/902 | 851/880 |

Word的open RPC为5832 ms，含排队、文件写入、load、初始化及状态返回；不是单独导入耗时，不能加算已完成的2284 ms启动。Word选区→工具493、字号395；PPT粗体202、mixed统一273，均单样本。

Markdown aSJhfZ：i7-13700/32GiB、1440×900 DPR1；6组主输入各100次保持焦点，beforeinput→rAF。1MiB split输入P95 5.6 ms，10MiB read/split 7.2/18.9 ms；巨段source/read/split 117.7/102.4/106.2 ms，最长任务126/114/128 ms。非物理paint，巨段未全部达标。4ref1q各10次真实点击read/split：到回执P95 211.9/214.2 ms，到首rAF校验235.6/225.2 ms，非paint。快速Undo未等ACK的n5HD89曾失败；这里只证明稳定序列。

前轮zign1t未记录焦点，普通尾延迟376 ms、巨段输入P95 322–416 ms，仅作诊断，不能据此计算加速比。


TEMP单次仓库诊断：1/10 MiB各70/35次小改累计blob写3.16/20.98 MB；各50次metadata额外blob均0。块比较后同步准备均值2.9/29.8 ms，不含TextAdapter编码、IPC、呈现。

10 MiB文档选12字符，本地dispatch响应JSON由完整快照10,513,298 B变为轻量1,502 B；无model、visibleText为空。这是序列化规模代理，不是Electron线上字节或UI时延。

## 待证明的目标

| 指标 | 目标 |
| --- | --- |
| 输入/按钮反馈P95 | ≤50 ms |
| 选区→可操作浮窗P95 | ≤100 ms |
| 属性刷新/格式生效P95 | ≤150/200 ms |
| 小型Office冷启动/热引擎打开 | ≤5/1.5 s |
| Markdown 1/10 MiB输入P95 | ≤50/100 ms |
| 连续开关20次 | 会话、队列、监听器、内存趋稳 |

固定机器、构建、DPR和样本，交互每场景≥100次、打开≥10次，区分冷/热并报告分布。当前冷启动、复杂mixed及完整交互P95尚未证明。P1分别追踪adapter.open、Kit load、initialize、首瓦片和first input；现有prewarm只准备通用服务，应评估空闲按格式空文档预热。原生辅助投影已在presented后；完整OOXML解析仍待解耦，但该Word小样reader_open仅51 ms，不能解释5.8 s open RPC。完整Markdown导出准备、全文编码/哈希、Core/App拆分及receipt/元数据统一预算待完成。

记录进程树CPU/private bytes、输入到呈现、IPC字节及队列等待；JS heap不等于总内存。证据留TEMP。

[审查](../review.md) · [测试](../../tests/README.md)
