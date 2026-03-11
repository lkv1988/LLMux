# LLMux

[English](./README.md) | [中文](#)

> 智能路由代理，支持 Claude API 成本追踪和故障转移

运行多个 Claude Code 会话？Opus 的费用是 Sonnet 的 5 倍。第三方供应商提供折扣但会随机超时。你需要智能路由、自动故障转移，以及了解钱花在哪里。

LLMux 是一个本地代理，根据模型类型将请求路由到不同供应商，自动故障转移，并通过实时监控面板追踪每个 token。

---

## 功能概览

```
智能路由            ·  故障转移 + 熔断器        ·  实时监控面板
成本追踪            ·  TTFB 监控              ·  热更新配置
请求修补            ·  JSONL 流量日志
```

**智能路由**：将 `claude-sonnet-*` 路由到供应商 A，`claude-opus-*` 路由到供应商 B——由你定义规则。
**故障转移**：供应商返回 429/500/超时？下一个供应商自动接管。
**熔断器**：失败的供应商被冷却 5 分钟以防止级联故障。
**成本追踪**：按供应商、按模型的 token 计数，支持折扣率。
**TTFB 监控**：追踪首字节时间；在慢速供应商阻塞你的工作流之前检测到它们。
**监控面板**：实时 UI，显示 token 速率、缓存命中率、供应商健康状态、活动趋势图。
**热更新**：编辑 `config.json`，更改立即生效，无需重启。
**请求修补**：通过剥离空文本块修复 Claude Code 边缘情况 400 错误。
**流量日志**：每日 JSONL 文件，15 天后自动清理。

---

## 监控面板

![LLMux 监控面板](./assets/dashboard-screenshot.png)

监控面板显示：
- 汇总卡片：总请求数、累计成本、平均 TTFB
- 供应商状态：实时健康指示器和冷却计时器
- Token 用量表：按模型统计，带 30 分钟活动趋势图
- 图表：小时/每日 token 趋势、模型分布饼图、缓存命中率对比
- 时间范围选择器：今天 / 7 天 / 30 天

启动代理后访问 `http://localhost:34250/dashboard`。

---

## 快速开始

### 1. 克隆并配置

```bash
git clone https://github.com/lkv1988/llmux.git
cd llmux
cp config.example.json config.json
```

使用你的 API 密钥编辑 `config.json`。这是一个将 Sonnet 路由到多个供应商的示例（你可以配置任何你想要的路由策略）：

```json
{
  "port": 34250,
  "cooldownMinutes": 5,
  "maxAttemptsPerProvider": 3,
  "ttfbTimeoutMs": 60000,
  "modelGroups": {
    "sonnet": [
      {
        "name": "provider_sonnet_cheap_1",
        "baseUrl": "https://api.cheap-proxy-1.com",
        "apiKey": "sk-YOUR_CHEAP_KEY_1",
        "discountRate": 0.5
      },
      {
        "name": "provider_sonnet_official_fallback",
        "baseUrl": "https://api.anthropic.com",
        "apiKey": "sk-ant-api03-YOUR_OFFICIAL_KEY_HERE",
        "discountRate": 1.0
      }
    ]
  }
}
```

### 2. 运行代理

```bash
npm start
# 或
node proxy.js
```

### 3. 将客户端指向代理

配置 Claude Code（或任何 Claude API 客户端）：

```bash
# 在 Claude Code 设置或环境变量中
Base URL: http://localhost:34250
API Key:  sk-ant-dummy-placeholder-key
```

API 密钥可以是任何有效格式——代理会忽略它并使用 `config.json` 中的密钥。

### 4. 打开监控面板

访问 `http://localhost:34250/dashboard` 实时查看请求流。

---

## 配置说明

### 供应商数组 = 优先级顺序

每个 `modelGroups` 数组中的供应商按顺序尝试。首个成功的获胜。如果供应商失败 `maxAttemptsPerProvider` 次（默认：3），它将进入冷却期，然后尝试下一个供应商。

```json
"sonnet": [
  { "name": "provider_1", ... },      // 首先尝试
  { "name": "provider_2", ... }       // 如果 provider_1 失败则尝试
]
```

**注意**：示例配置展示了"便宜供应商优先，官方后备"的策略，但你可以配置任何你想要的路由顺序。代理不假设或强制任何特定的供应商层级。

### 模型匹配

`modelGroups` 的键通过**不区分大小写的子串搜索**匹配模型名称：

- `"opus"` 匹配 `claude-opus-4-6`、`claude-opus-3-5-20240229`
- `"sonnet"` 匹配 `claude-sonnet-4-6`、`claude-sonnet-3-5-20240620`
- `"haiku"` 匹配 `claude-haiku-4-5-20251001`

如果没有组匹配，则使用 `defaultProviders`。

### 折扣率

`discountRate` **仅影响监控面板的成本显示**——不影响路由逻辑。将其设置为你实际支付的倍率：

- `1.0` = 官方全价
- `0.5` = 50% 折扣
- `0.8` = 20% 折扣

这让监控面板能够显示供应商之间准确的成本对比。

### 配置参考

| 字段 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `port` | number | 34250 | 服务器端口（如被占用则自动递增） |
| `cooldownMinutes` | number | 5 | 熔断器冷却时长 |
| `maxAttemptsPerProvider` | number | 3 | 故障转移前每个供应商的重试次数 |
| `ttfbTimeoutMs` | number | 60000 | 首字节超时时间（毫秒） |

**供应商字段：**

| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `name` | string | 是 | 唯一供应商标识符 |
| `baseUrl` | string | 是 | API 端点基础 URL |
| `apiKey` | string | 是 | API 认证密钥 |
| `discountRate` | number | 否 | 监控面板的成本倍率（1.0 = 全价） |

---

## 工作原理

请求生命周期的 8 个步骤：

1. **客户端发送请求**到 `http://localhost:34250/v1/messages`，带有模型名称（例如 `claude-sonnet-4-6`）
2. **模型匹配**：代理扫描 `modelGroups` 键进行不区分大小写的子串匹配（`"sonnet"` 匹配 `claude-sonnet-4-6`）
3. **请求修补**：从消息内容中剥离任何空文本块（修复 Claude Code 边缘情况 400 错误）
4. **供应商选择**：过滤掉处于冷却期的供应商，构建按优先级排序的列表
5. **带重试的尝试**：尝试第一个供应商最多 `maxAttemptsPerProvider` 次，重试之间延迟 500ms
6. **TTFB 超时检测**：如果在 `ttfbTimeoutMs`（默认：60 秒）内没有响应，终止请求并尝试下一个供应商
7. **错误时故障转移**：HTTP 429/401/403/5xx 触发立即故障转移到下一个供应商；失败的供应商进入冷却期
8. **成功**：将响应流式传输回客户端，从 SSE 流或 JSON 主体中提取 token 使用情况，更新统计数据

**热配置重载**：通过 `fs.watch` 检测 `config.json` 的更改并立即应用——重载时清除所有供应商冷却记录。

**熔断器**：失败的供应商被冷却 `cooldownMinutes`（默认：5 分钟）。如果所有供应商都在冷却期，代理会强制重试（尝试不稳定的供应商总比立即失败好）。

---

## 成本追踪与监控面板

监控面板回答了你的 API 账单无法回答的问题：

**我的钱花在哪里了？**
- 按供应商、按模型的 token 明细，显示实际成本（遵循 `discountRate`）
- 小时和每日汇总——查看哪些会话消耗了你的预算

**我的折扣供应商在欺骗我吗？**
- 缓存命中率对比：`cache_read_input_tokens` vs `total_input_tokens`
- 如果你的折扣供应商显示 0% 缓存命中率，而另一个显示 40%，那就有问题了

**哪个供应商更快？**
- 每个供应商的平均 TTFB——在慢速端点阻塞你的工作流之前识别它们

**我当前的速率是多少？**
- Tokens/分钟 和 tokens/小时——追踪重度编码会话期间的突发活动

**活动模式：**
- 每个模型的 30 分钟趋势图——可视化一段时间内的请求分布
- 小时趋势图——识别高峰使用时段

所有数据通过服务器发送事件（SSE）实时更新。无需轮询，无需刷新。

---

## 技术细节

- **架构**：单文件 Node.js HTTP 代理（`proxy.js`）+ 静态监控面板 HTML
- **后端依赖**：零——代理仅使用 Node.js 内置模块（`http`、`https`、`fs`、`events`）
- **前端依赖**：ECharts（图表）、Tailwind CSS（样式），通过 CDN 加载
- **要求**：Node.js >= 18
- **日志**：`logs/` 目录中的每日 JSONL 文件，15 天后自动清理
- **统计持久化**：Token 统计保存到 `token_stats.json`（每 2 秒防抖写入）
- **端口处理**：如果默认端口（34250）被占用则自动递增

---

## 许可证

AGPL-3.0
