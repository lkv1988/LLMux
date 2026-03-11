# LLMux

> Zero-dependency local LLM API proxy with smart routing, failover, circuit breaker and real-time dashboard

[English](#english) | [中文](#中文)

---

## English

### What is LLMux

LLMux is a lightweight, zero-dependency Node.js proxy for Anthropic Claude API that provides:

- **Smart Routing**: Route requests to different providers based on model type (Opus/Sonnet/Haiku)
- **Automatic Failover**: Seamlessly switch to backup providers when primary fails
- **Circuit Breaker**: Temporarily disable failing providers to prevent cascading failures
- **Real-time Dashboard**: Monitor token usage, costs, and provider status in real-time
- **Hot Reload**: Update configuration without restarting the server
- **Cost Tracking**: Track token usage and costs with discount rate support

### Features

- ✅ Zero dependencies - pure Node.js built-in modules only
- 🔄 Smart provider routing with automatic failover
- 🛡️ Circuit breaker pattern for provider health management
- 📊 Real-time SSE-powered dashboard with ECharts visualization
- 💰 Token usage tracking with hourly/daily statistics
- 🔥 Hot configuration reload without downtime
- ⚡ TTFB (Time To First Byte) monitoring
- 📈 Request velocity tracking (tokens/min, tokens/hour)
- 🎯 Model-based routing (Opus/Sonnet/Haiku)
- 🔧 Configurable retry attempts and cooldown periods

### Quick Start

#### 1. Clone and Setup

\`\`\`bash
git clone https://github.com/yourusername/llmux.git
cd llmux
cp config.example.json config.json
\`\`\`

#### 2. Configure

Edit \`config.json\` with your API keys and provider settings:

\`\`\`json
{
  "port": 34250,
  "cooldownMinutes": 5,
  "maxAttemptsPerProvider": 3,
  "ttfbTimeoutMs": 60000,
  "modelGroups": {
    "sonnet": [
      {
        "name": "my_provider",
        "baseUrl": "https://api.anthropic.com",
        "apiKey": "sk-ant-api03-YOUR_KEY_HERE",
        "discountRate": 1.0
      }
    ]
  }
}
\`\`\`

#### 3. Run

\`\`\`bash
npm start
# or
node proxy.js
\`\`\`

#### 4. Configure Your Client

Point your Claude API client to:

- **Base URL**: \`http://localhost:34250\`
- **API Key**: Any valid format (e.g., \`sk-ant-dummy-placeholder-key\`)

#### 5. Access Dashboard

Open \`http://localhost:34250/dashboard\` in your browser to monitor real-time statistics.

### Configuration Reference

#### Top-level Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| \`port\` | number | 34250 | Server listening port (auto-increments if occupied) |
| \`cooldownMinutes\` | number | 5 | Circuit breaker cooldown duration in minutes |
| \`maxAttemptsPerProvider\` | number | 3 | Max retry attempts per provider before failover |
| \`ttfbTimeoutMs\` | number | 60000 | Time To First Byte timeout in milliseconds |

#### Provider Configuration

Each provider in \`modelGroups\` or \`defaultProviders\` supports:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| \`name\` | string | Yes | Unique provider identifier |
| \`baseUrl\` | string | Yes | API endpoint base URL |
| \`apiKey\` | string | Yes | API authentication key |
| \`discountRate\` | number | No | Cost multiplier for dashboard (1.0 = full price, 0.5 = 50% off) |

#### Model Groups

Define routing rules in \`modelGroups\`:

\`\`\`json
{
  "modelGroups": {
    "opus": [...],    // Routes claude-opus-* models
    "sonnet": [...],  // Routes claude-sonnet-* models
    "haiku": [...]    // Routes claude-haiku-* models
  },
  "defaultProviders": [...]  // Fallback for unmatched models
}
\`\`\`

Providers are tried in array order. First successful response wins.

### Dashboard

The real-time dashboard provides:

- **Summary Cards**: Total requests, costs, average TTFB
- **Provider Status**: Live health status with cooldown indicators
- **Token Usage Table**: Per-model statistics with sparkline activity
- **Charts**: Hourly/daily trends and model distribution
- **Time Range Selector**: Today / 7 days / 30 days

### License

AGPL-3.0

---

## 中文

### LLMux 是什么

LLMux 是一个轻量级、零依赖的 Node.js 代理服务器，专为 Anthropic Claude API 设计，提供：

- **智能路由**：根据模型类型（Opus/Sonnet/Haiku）将请求路由到不同供应商
- **自动故障转移**：主供应商失败时无缝切换到备用供应商
- **熔断机制**：临时禁用失败的供应商以防止级联故障
- **实时监控面板**：实时监控 Token 用量、成本和供应商状态
- **热更新**：无需重启服务器即可更新配置
- **成本追踪**：支持折扣率的 Token 用量和成本追踪

### 功能特性

- ✅ 零依赖 - 仅使用 Node.js 内置模块
- 🔄 智能供应商路由与自动故障转移
- 🛡️ 熔断器模式管理供应商健康状态
- 📊 基于 SSE 的实时监控面板，使用 ECharts 可视化
- 💰 Token 用量追踪，支持小时/每日统计
- 🔥 配置热更新，无需停机
- ⚡ TTFB（首字节时间）监控
- 📈 请求速率追踪（tokens/分钟、tokens/小时）
- 🎯 基于模型的路由（Opus/Sonnet/Haiku）
- 🔧 可配置的重试次数和冷却周期

### 快速开始

#### 1. 克隆并设置

\`\`\`bash
git clone https://github.com/yourusername/llmux.git
cd llmux
cp config.example.json config.json
\`\`\`

#### 2. 配置

编辑 \`config.json\`，填入你的 API 密钥和供应商设置：

\`\`\`json
{
  "port": 34250,
  "cooldownMinutes": 5,
  "maxAttemptsPerProvider": 3,
  "ttfbTimeoutMs": 60000,
  "modelGroups": {
    "sonnet": [
      {
        "name": "my_provider",
        "baseUrl": "https://api.anthropic.com",
        "apiKey": "sk-ant-api03-YOUR_KEY_HERE",
        "discountRate": 1.0
      }
    ]
  }
}
\`\`\`

#### 3. 运行

\`\`\`bash
npm start
# 或
node proxy.js
\`\`\`

#### 4. 配置客户端

将你的 Claude API 客户端指向：

- **Base URL**: \`http://localhost:34250\`
- **API Key**: 任意有效格式（例如 \`sk-ant-dummy-placeholder-key\`）

#### 5. 访问监控面板

在浏览器中打开 \`http://localhost:34250/dashboard\` 查看实时统计数据。

### 配置参考

#### 顶层选项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| \`port\` | number | 34250 | 服务器监听端口（如被占用会自动递增） |
| \`cooldownMinutes\` | number | 5 | 熔断器冷却时长（分钟） |
| \`maxAttemptsPerProvider\` | number | 3 | 每个供应商的最大重试次数 |
| \`ttfbTimeoutMs\` | number | 60000 | 首字节超时时间（毫秒） |

#### 供应商配置

\`modelGroups\` 或 \`defaultProviders\` 中的每个供应商支持：

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| \`name\` | string | 是 | 唯一供应商标识符 |
| \`baseUrl\` | string | 是 | API 端点基础 URL |
| \`apiKey\` | string | 是 | API 认证密钥 |
| \`discountRate\` | number | 否 | 面板成本倍率（1.0 = 原价，0.5 = 五折） |

#### 模型组

在 \`modelGroups\` 中定义路由规则：

\`\`\`json
{
  "modelGroups": {
    "opus": [...],    // 路由 claude-opus-* 模型
    "sonnet": [...],  // 路由 claude-sonnet-* 模型
    "haiku": [...]    // 路由 claude-haiku-* 模型
  },
  "defaultProviders": [...]  // 未匹配模型的后备供应商
}
\`\`\`

供应商按数组顺序尝试，首个成功响应即返回。

### 监控面板

实时监控面板提供：

- **汇总卡片**：总请求数、总成本、平均 TTFB
- **供应商状态**：实时健康状态与冷却指示器
- **Token 用量表**：按模型统计，带活动趋势图
- **图表**：小时/每日趋势和模型分布
- **时间范围选择器**：今天 / 7 天 / 30 天

### 许可证

AGPL-3.0
