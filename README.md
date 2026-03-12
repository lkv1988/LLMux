# LLMux

[English](#) | [中文](./README_zh.md)

> Smart routing proxy for Claude API with cost tracking and failover

Running multiple Claude Code sessions? Opus costs 5× more than Sonnet. Third-party providers offer discounts but timeout randomly. You need smart routing, automatic failover, and visibility into where your money goes.

LLMux is a local proxy that routes requests to different providers based on model type, fails over automatically, and tracks every token with a real-time dashboard.

---

## What It Does

```
Smart Routing       ·  Failover + Circuit Breaker  ·  Real-time Dashboard
Cost Tracking       ·  TTFB Monitoring             ·  Hot Config Reload
Request Patching    ·  JSONL Traffic Logs
```

**Smart Routing**: Route `claude-sonnet-*` to provider A, `claude-opus-*` to provider B—you define the rules.
**Failover**: Provider returns 429/500/timeout? Next provider takes over automatically.
**Circuit Breaker**: Failed providers get benched for 5 minutes to prevent cascade failures.
**Cost Tracking**: Per-provider, per-model token counts with discount rate support.
**TTFB Monitoring**: Track Time To First Byte; detect slow providers before they block your workflow.
**Dashboard**: Real-time UI with token velocity, cache hit rates, provider health, sparkline activity.
**Hot Reload**: Edit `config.json`, changes apply instantly without restarting.
**Request Patching**: Fixes Claude Code edge-case 400 errors by stripping empty text blocks.
**Traffic Logs**: Daily JSONL files, auto-cleaned after 15 days.

---

## Dashboard

<img src="./assets/dashboard-screenshot.png" alt="LLMux Dashboard" width="350px">

The dashboard shows:
- Summary cards: total requests, cumulative cost, average TTFB
- Provider status: live health indicators with cooldown timers
- Token usage table: per-model stats with configurable-window sparkline activity graphs (default 4-hour)
- Charts: hourly/daily token trends, model distribution pie chart, cache hit rate comparison
- Time range selector: today / 7 days / 30 days

Access at `http://localhost:34250/dashboard` after starting the proxy. On macOS, the dashboard automatically opens in Chrome app mode (independent window) when the proxy starts.

---

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/lkv1988/llmux.git
cd llmux
cp config.example.json config.json
```

Edit `config.json` with your API keys. Here's an example that routes Sonnet to multiple providers (you can configure any routing strategy you want):

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

### 2. Run the proxy

```bash
npm start
# or
node proxy.js
```

### 3. Point your client to the proxy

Configure Claude Code (or any Claude API client):

```bash
# In Claude Code settings or environment
Base URL: http://localhost:34250
API Key:  sk-ant-dummy-placeholder-key
```

The API key can be any valid format—the proxy ignores it and uses keys from `config.json`.

### 4. Open the dashboard

On macOS, the dashboard automatically opens in Chrome app mode when the proxy starts. Otherwise, navigate to `http://localhost:34250/dashboard` to watch requests flow in real-time.

---

## Configuration

### Provider Arrays = Priority Order

Providers in each `modelGroups` array are tried in order. First success wins. If a provider fails `maxAttemptsPerProvider` times (default: 3), it enters cooldown and the next provider is tried.

```json
"sonnet": [
  { "name": "provider_1", ... },      // Tried first
  { "name": "provider_2", ... }       // Tried if provider_1 fails
]
```

**Note**: The example config shows a "cheap provider first, official fallback" strategy, but you can configure any routing order you want. The proxy doesn't assume or enforce any specific provider hierarchy.

### Model Matching

`modelGroups` keys match model names via **case-insensitive substring search**:

- `"opus"` matches `claude-opus-4-6`, `claude-opus-3-5-20240229`
- `"sonnet"` matches `claude-sonnet-4-6`, `claude-sonnet-3-5-20240620`
- `"haiku"` matches `claude-haiku-4-5-20251001`

If no group matches, `defaultProviders` is used.

### Discount Rate

`discountRate` **only affects dashboard cost display**—it does not influence routing logic. Set it to the actual multiplier you pay:

- `1.0` = full official price
- `0.5` = 50% discount
- `0.8` = 20% discount

This lets the dashboard show accurate cost comparisons between providers.

### Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | number | 34250 | Server port (auto-increments if occupied) |
| `cooldownMinutes` | number | 5 | Circuit breaker cooldown duration |
| `maxAttemptsPerProvider` | number | 3 | Retry attempts per provider before failover |
| `ttfbTimeoutMs` | number | 60000 | Time To First Byte timeout (ms) |
| `activity.windowMinutes` | number | 240 | Activity sparkline time window (minutes) |
| `activity.bucketMinutes` | number | 10 | Activity data bucket size (minutes) |
| `activity.pushIntervalMs` | number | 5000 | Activity data push interval to dashboard (ms) |

**Provider fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique provider identifier |
| `baseUrl` | string | Yes | API endpoint base URL |
| `apiKey` | string | Yes | API authentication key |
| `discountRate` | number | No | Cost multiplier for dashboard (1.0 = full price) |

---

## How It Works

Request lifecycle in 8 steps:

1. **Client sends request** to `http://localhost:34250/v1/messages` with model name (e.g., `claude-sonnet-4-6`)
2. **Model matching**: Proxy scans `modelGroups` keys for case-insensitive substring match (`"sonnet"` matches `claude-sonnet-4-6`)
3. **Request patching**: Strips any empty text blocks from message content (fixes Claude Code edge-case 400 errors)
4. **Provider selection**: Filters out providers in cooldown, builds priority-ordered list
5. **Attempt with retries**: Tries first provider up to `maxAttemptsPerProvider` times with 500ms delay between retries
6. **TTFB timeout detection**: If no response within `ttfbTimeoutMs` (default: 60s), kills request and tries next provider
7. **Failover on error**: HTTP 429/401/403/5xx triggers immediate failover to next provider; failed provider enters cooldown
8. **Success**: Streams response back to client, extracts token usage from SSE stream or JSON body, updates stats

**Hot config reload**: `config.json` changes are detected via `fs.watch` and applied instantly—all provider cooldowns are cleared on reload.

**Circuit breaker**: Failed providers are benched for `cooldownMinutes` (default: 5). If all providers are in cooldown, the proxy forces a retry anyway (better to try a flaky provider than fail immediately).

---

## Cost Tracking & Dashboard

The dashboard answers questions your API bill can't:

**Where is my money going?**
- Per-provider, per-model token breakdown with actual cost (respecting `discountRate`)
- Hourly and daily aggregation—see which sessions burned through your budget

**Is my discount provider cheating me?**
- Cache hit rate comparison: `cache_read_input_tokens` vs `total_input_tokens`
- If your discount provider shows 0% cache hits while another shows 40%, something's wrong

**Which provider is faster?**
- Average TTFB per provider—identify slow endpoints before they block your workflow

**What's my current velocity?**
- Tokens per bucket and per window—track burst activity during heavy coding sessions (configurable time windows)

**Activity patterns:**
- Configurable-window sparkline graphs per model (default 4-hour)—visualize request distribution over time
- Hourly trend charts—identify peak usage hours

All data updates in real-time via Server-Sent Events (SSE). No polling, no refresh needed.

---

## Technical Details

- **Architecture**: Single-file Node.js HTTP proxy (`proxy.js`) + static dashboard HTML
- **Backend Dependencies**: Zero—proxy uses only Node.js built-in modules (`http`, `https`, `fs`, `events`)
- **Frontend Dependencies**: ECharts (charts), Tailwind CSS (styling), loaded via CDN
- **Requirements**: Node.js >= 18
- **Logs**: Daily JSONL files in `logs/` directory, auto-cleaned after 15 days
- **Stats persistence**: Token statistics saved to `data/token_stats.json` (debounced writes every 2s); activity data saved to `data/activity_data.json` (persisted on shutdown)
- **Port handling**: Auto-increments if default port (34250) is occupied

---

## License

AGPL-3.0
