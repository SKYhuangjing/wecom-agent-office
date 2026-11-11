# code-guard

出站中间件插件:对开启 `providerConfig.codeGuard: true` 的机器人,最终企微回复里的**代码块**在发出前被替换为一句业务话术。提示词层管不住的样本(2026-11-11 盲评:deepseek-flash 5 轮里 2 轮贴完整爬虫模板、1 轮绕道写进源码目录)由这一层兜底;写文件路径已由 `piArgs: ["--exclude-tools","write,edit"]` 关死,本插件关文本路径。

## 行为口径

- 带编程语言标签的围栏(```python / js / bash / …)一律替换;
- 无标签围栏仅在内容呈强代码特征(def/class/import/function/const/… 行首)时替换;
- `json` 围栏与普通文本围栏(引日志、表格)原样放行——过度拦截比漏拦更伤;
- 替换文案:`（代码内容已略去——写代码类需求请找技术同事处理）`;围栏外的业务文本不动,回复永不被清空。
- 挂在 middleware 链(cost-tracker 同款 §5.5 端口),抛错被引擎隔离、原文照发。

## 开关

```json
{ "providerConfig": { "codeGuard": true } }
```

防御式读取(同 toolLoopMaxCalls 先例),未知引擎键自由通过;普通 bot PATCH 即翻转,四家引擎通用。
