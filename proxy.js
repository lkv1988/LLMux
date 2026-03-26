const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { EventEmitter } = require('events');
const JSON5 = require('json5');

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ==========================================
// 1. Load external config file config.json5 (hot reload support)
// ==========================================
const configPath = path.join(__dirname, 'config.json5');
let config;

function loadConfig() {
  try {
    const configFile = fs.readFileSync(configPath, 'utf8');
    config = JSON5.parse(configFile);
    console.log('✅ Config loaded: config.json5');
    return true;
  } catch (err) {
    console.error('❌ Failed to read or parse config.json5:', err.message);
    return false;
  }
}

let ACT_WINDOW_MIN = 240;
let ACT_BUCKET_MIN = 5;
let ACT_BUCKET_COUNT = 48;
let ACT_PUSH_INTERVAL = 5000;

function applyActivityConfig() {
  const actCfg = config.activity || {};
  ACT_WINDOW_MIN = actCfg.windowMinutes || 240;
  ACT_BUCKET_MIN = actCfg.bucketMinutes || 5;
  ACT_BUCKET_COUNT = Math.floor(ACT_WINDOW_MIN / ACT_BUCKET_MIN);
  ACT_PUSH_INTERVAL = actCfg.pushIntervalMs || 5000;
  console.log(`📊 Activity config: window=${ACT_WINDOW_MIN}min, bucket=${ACT_BUCKET_MIN}min, count=${ACT_BUCKET_COUNT}, push=${ACT_PUSH_INTERVAL}ms`);
}

// Initial config load
if (!loadConfig()) {
  process.exit(1);
}
applyActivityConfig();

// Watch config file changes (hot reload)
fs.watch(configPath, (eventType, filename) => {
  if (eventType === 'change') {
    console.log(`\n🔄 Detected ${filename} change, reloading config...`);
    setTimeout(() => {
      if (loadConfig()) {
        console.log('🧹 Config updated, clearing all provider cooldown records...');
        cooldowns.clear();
        const prevBucket = ACT_BUCKET_MIN;
        const prevWindow = ACT_WINDOW_MIN;
        applyActivityConfig();
        if (ACT_BUCKET_MIN !== prevBucket || ACT_WINDOW_MIN !== prevWindow) {
          Object.keys(sparklineData).forEach(key => delete sparklineData[key]);
          tokenEventsQueue.length = 0;
          try { fs.unlinkSync(activityDataPath); } catch (e) {}
        }
      }
    }, 100);
  }
});

// ==========================================
// Event Bus
// ==========================================
const proxyEvents = new EventEmitter();

// ==========================================
// logMessage() — Unified logging function (console + SSE)
// ==========================================
function logMessage(level, message, reqId) {
  if (level === 'error') {
    console.error(message);
  } else {
    console.log(message);
  }
  proxyEvents.emit('log', { level, message, reqId });
}

// ==========================================
// Log Rotation — logs/ directory + daily naming + 15-day cleanup
// ==========================================
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

function getLogFilePath() {
  const date = localDateStr();
  return path.join(logsDir, `proxy_traffic_${date}.jsonl`);
}

function logToJSONL(data) {
  try {
    const logLine = JSON.stringify({ timestamp: new Date().toISOString(), ...data }) + '\n';
    fs.appendFileSync(getLogFilePath(), logLine, 'utf8');
  } catch (e) {
    console.error('❌ [Log Error] Failed to write log file:', e.message);
  }
}

function cleanOldLogs() {
  try {
    const files = fs.readdirSync(logsDir);
    const cutoff = Date.now() - 15 * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(logsDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (e) {
    // Cleanup failure doesn't affect main flow
  }
}
cleanOldLogs();

// ==========================================
// 2. In-memory provider circuit breaker (cooldown time)
// ==========================================
// cooldowns Map: key = "modelGroup:providerName", value = expiry timestamp (ms)
const cooldowns = new Map();

function isProviderInCooldown(groupKey, providerName) {
  const expiry = cooldowns.get(`${groupKey}:${providerName}`);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    cooldowns.delete(`${groupKey}:${providerName}`);
    return false;
  }
  return true;
}

function setProviderCooldown(groupKey, providerName) {
  const minutes = config.cooldownMinutes || 5;
  const expiry = Date.now() + minutes * 60 * 1000;
  cooldowns.set(`${groupKey}:${providerName}`, expiry);
  logMessage('warn', `⚠️  [Circuit Breaker] Provider '${providerName}' failed, added to cooldown queue (${minutes} min)`);
  proxyEvents.emit('provider_status', {
    group: groupKey,
    provider: providerName,
    status: 'cooldown',
    expiry
  });
}

// ==========================================
// Token statistics + persistent storage (date > provider > model)
// ==========================================
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const tokenStatsPath = path.join(dataDir, 'token_stats.json');
let TokenStats = {};
let saveTimeout = null;

const activityDataPath = path.join(dataDir, 'activity_data.json');
let activitySaveTimeout = null;

// Velocity queue: each element { ts: timestamp, count: tokens }
const tokenEventsQueue = [];

// Sparkline sliding window: key = "provider__model", value = [{minute, count}]
const sparklineData = {};

function loadStats() {
  try {
    if (fs.existsSync(tokenStatsPath)) {
      const data = fs.readFileSync(tokenStatsPath, 'utf8');
      TokenStats = JSON.parse(data);
      console.log('📊 Historical token stats loaded');
    }
  } catch (err) {
    console.error(`❌ Failed to read token_stats.json: ${err.message}`);
    TokenStats = {};
  }
}

function saveStats() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(tokenStatsPath, JSON.stringify(TokenStats, null, 2), 'utf8');
    } catch (err) {
      console.error(`❌ Failed to write token_stats.json: ${err.message}`);
    }
  }, 2000);
}

function saveActivityData() {
  if (activitySaveTimeout) clearTimeout(activitySaveTimeout);
  activitySaveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(activityDataPath, JSON.stringify({
        config: { windowMinutes: ACT_WINDOW_MIN, bucketMinutes: ACT_BUCKET_MIN },
        tokenEventsQueue,
        sparklineData
      }), 'utf8');
    } catch (err) {
      console.error(`❌ Failed to write activity_data.json: ${err.message}`);
    }
  }, 5000);
}

function loadActivityData() {
  try {
    if (!fs.existsSync(activityDataPath)) return;
    const data = JSON.parse(fs.readFileSync(activityDataPath, 'utf8'));
    const savedCfg = data.config || {};
    if (savedCfg.bucketMinutes !== ACT_BUCKET_MIN || savedCfg.windowMinutes !== ACT_WINDOW_MIN) {
      console.log('📊 Activity config changed, discarding persisted data');
      try { fs.unlinkSync(activityDataPath); } catch (e) {}
      return;
    }
    const windowAgo = Date.now() - ACT_WINDOW_MIN * 60000;
    if (Array.isArray(data.tokenEventsQueue)) {
      tokenEventsQueue.push(...data.tokenEventsQueue.filter(e => e.ts >= windowAgo));
    }
    if (data.sparklineData && typeof data.sparklineData === 'object') {
      const now = Math.floor(Date.now() / (ACT_BUCKET_MIN * 60000));
      const cutoff = now - ACT_BUCKET_COUNT;
      for (const [key, buckets] of Object.entries(data.sparklineData)) {
        if (!Array.isArray(buckets)) continue;
        const valid = buckets.filter(b => b.bucket >= cutoff);
        if (valid.length > 0) sparklineData[key] = valid;
      }
    }
    console.log(`📊 Activity data restored: ${tokenEventsQueue.length} events, ${Object.keys(sparklineData).length} series`);
  } catch (err) {
    console.error(`❌ Failed to load activity_data.json: ${err.message}`);
  }
}

function updateTokenStats(providerName, model, usage, ttfbMs) {
  if (!usage) return;

  const today = localDateStr();
  const currentHour = new Date().getHours();

  if (!TokenStats[today]) TokenStats[today] = {};
  if (!TokenStats[today][providerName]) TokenStats[today][providerName] = {};
  if (!TokenStats[today][providerName][model]) {
    TokenStats[today][providerName][model] = {
      total_input: 0,
      total_output: 0,
      cache_read: 0,
      cache_creation: 0,
      request_count: 0,
      total_ttfb: 0,
      hourly: {}
    };
  }

  const stats = TokenStats[today][providerName][model];
  stats.total_input += (usage.input_tokens || 0);
  stats.total_output += (usage.output_tokens || 0);
  stats.cache_read += (usage.cache_read_input_tokens || 0);
  stats.cache_creation += (usage.cache_creation_input_tokens || 0);
  stats.request_count = (stats.request_count || 0) + 1;
  stats.total_ttfb = (stats.total_ttfb || 0) + (ttfbMs || 0);

  // Update hourly statistics
  const hourlyTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) +
                       (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  if (!stats.hourly) stats.hourly = {};
  stats.hourly[currentHour] = (stats.hourly[currentHour] || 0) + hourlyTokens;

  // Velocity queue
  const activeTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  if (activeTokens > 0) {
    tokenEventsQueue.push({ ts: Date.now(), count: activeTokens });
  }

  // Sparkline recording (bucket-level, keep last N buckets)
  const sparkKey = `${providerName}__${model}`;
  const bucket = Math.floor(Date.now() / (ACT_BUCKET_MIN * 60000));
  if (!sparklineData[sparkKey]) sparklineData[sparkKey] = [];
  const buckets = sparklineData[sparkKey];
  if (buckets.length > 0 && buckets[buckets.length - 1].bucket === bucket) {
    buckets[buckets.length - 1].count++;
  } else {
    buckets.push({ bucket: bucket, count: 1 });
  }
  const cutoff = bucket - ACT_BUCKET_COUNT;
  while (buckets.length > 0 && buckets[0].bucket < cutoff) buckets.shift();

  saveStats();
  saveActivityData();

  proxyEvents.emit('stats_update', {
    date: today,
    provider: providerName,
    model,
    stats,
    velocity: calculateVelocity(),
    spark: getSparkline(providerName, model)
  });
}

function calculateVelocity() {
  const now = Date.now();
  const bucketAgo = now - ACT_BUCKET_MIN * 60000;
  const windowAgo = now - ACT_WINDOW_MIN * 60000;

  // Clean up data older than window
  while (tokenEventsQueue.length > 0 && tokenEventsQueue[0].ts < windowAgo) {
    tokenEventsQueue.shift();
  }

  let tokensLastBucket = 0;
  let tokensLastWindow = 0;

  for (let i = tokenEventsQueue.length - 1; i >= 0; i--) {
    const event = tokenEventsQueue[i];
    if (event.ts >= bucketAgo) {
      tokensLastBucket += event.count;
    }
    tokensLastWindow += event.count;
  }

  return {
    tokensPerBucket: tokensLastBucket,
    tokensPerWindow: tokensLastWindow,
    tokensPerMinute: Math.round(tokensLastBucket / ACT_BUCKET_MIN),
    tokensPerHour: Math.round(tokensLastWindow / (ACT_WINDOW_MIN / 60)),
    bucketMinutes: ACT_BUCKET_MIN,
    windowMinutes: ACT_WINDOW_MIN
  };
}

function getSparkline(provider, model) {
  const key = `${provider}__${model}`;
  const buckets = sparklineData[key] || [];
  const now = Math.floor(Date.now() / (ACT_BUCKET_MIN * 60000));
  const result = new Array(ACT_BUCKET_COUNT).fill(0);
  for (const b of buckets) {
    const idx = ACT_BUCKET_COUNT - 1 - (now - b.bucket);
    if (idx >= 0 && idx < ACT_BUCKET_COUNT) result[idx] = b.count;
  }
  return result;
}

function getAllSparklines() {
  const result = {};
  for (const key of Object.keys(sparklineData)) {
    const dunder = key.indexOf('__');
    const provider = key.slice(0, dunder);
    const model = key.slice(dunder + 2);
    // 前端期望的键格式是 model__provider
    result[`${model}__${provider}`] = getSparkline(provider, model);
  }
  return result;
}

loadStats();
loadActivityData();

setInterval(() => {
  proxyEvents.emit('velocity_update', {
    ...calculateVelocity(),
    sparklines: getAllSparklines()
  });
}, ACT_PUSH_INTERVAL);

// ==========================================
// SSE client management
// ==========================================
const sseClients = new Set();

function broadcastSSE(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Event bridge: proxyEvents → SSE broadcast
proxyEvents.on('log', data => broadcastSSE('log', data));
proxyEvents.on('stats_update', data => broadcastSSE('stats_update', data));
proxyEvents.on('velocity_update', data => broadcastSSE('velocity_update', data));
proxyEvents.on('provider_status', data => broadcastSSE('provider_status', data));

// ==========================================
// Build fully compliant Anthropic error response
// ==========================================
function sendAnthropicError(res, statusCode, errorType, message, reqId = 'unknown') {
  const errorObj = {
    type: 'error',
    error: {
      type: errorType,
      message: message
    }
  };

  logToJSONL({
    reqId,
    type: 'proxy_error_response',
    statusCode,
    body: errorObj
  });

  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(errorObj));
}

// ==========================================
// Single provider request Promise wrapper
// (+requestedModel parameter, +usage extraction)
// ==========================================
function attemptProviderRequest(req, res, bodyBuffer, targetProvider, reqId, requestedModel) {
  return new Promise((resolve, reject) => {
    const attemptStartMs = Date.now();
    const baseUrl = targetProvider.baseUrl.replace(/\/$/, '');
    const targetUrl = new URL(baseUrl + req.url);

    const proxyHeaders = { ...req.headers };
    delete proxyHeaders['host'];
    delete proxyHeaders['authorization'];  // Remove client's auth header before setting provider's key
    proxyHeaders['host'] = targetUrl.host;
    proxyHeaders['x-api-key'] = targetProvider.apiKey;
    proxyHeaders['content-length'] = Buffer.byteLength(bodyBuffer);

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: proxyHeaders,
      timeout: 300000
    };

    const requestModule = targetUrl.protocol === 'https:' ? https : http;

    const ttfbTimeout = config.ttfbTimeoutMs || 60000;
    let proxyReq;
    const ttfbTimer = setTimeout(() => {
      proxyReq.destroy();
      reject(new Error(`TTFB Timeout (${ttfbTimeout / 1000}s)`));
    }, ttfbTimeout);

    proxyReq = requestModule.request(options, proxyRes => {
      clearTimeout(ttfbTimer);
      const ttfbMs = Date.now() - attemptStartMs;
      const statusCode = proxyRes.statusCode;
      const shouldFallback = statusCode === 424 || statusCode === 429 || statusCode === 401 || statusCode === 403 || statusCode >= 500;

      if (shouldFallback) {
        let errorBody = '';
        proxyRes.on('data', chunk => errorBody += chunk.toString('utf8'));
        proxyRes.on('end', () => {
          logToJSONL({
            reqId,
            type: 'provider_error',
            provider: targetProvider.name,
            statusCode,
            responseHeaders: proxyRes.headers,
            body: errorBody
          });
          reject(new Error(`HTTP ${statusCode} (unavailable or rate limited)`));
        });
        return;
      }

      // Normal response (200 etc.)
      // Check if headers were already sent (e.g., from a previous failed attempt)
      if (res.headersSent) {
        reject(new Error('Response headers already sent, cannot retry'));
        return;
      }

      res.writeHead(proxyRes.statusCode, proxyRes.headers);

      let responseBodyAccumulator = '';

      proxyRes.on('data', chunk => {
        responseBodyAccumulator += chunk.toString('utf8');
        res.write(chunk);
      });

      proxyRes.on('end', () => {
        res.end();
        logToJSONL({
          reqId,
          type: 'response',
          provider: targetProvider.name,
          statusCode: proxyRes.statusCode,
          responseHeaders: proxyRes.headers,
          body: responseBodyAccumulator
        });

        // Extract usage data:
        // Preferred: usage object from SSE stream event: message_delta (final cumulative value)
        // Fallback: parse JSON directly from non-streaming response
        try {
          let usage = null;

          // Try to find last data block with usage from SSE stream
          const sseDataMatches = [...responseBodyAccumulator.matchAll(/^data:\s*(.+)$/gm)];
          for (let i = sseDataMatches.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(sseDataMatches[i][1]);
              if (parsed.usage && typeof parsed.usage.input_tokens === 'number') {
                usage = parsed.usage;
                break;
              }
            } catch (e) {
              // Skip unparseable data lines
            }
          }

          // Fallback: try parsing entire JSON (non-streaming response)
          if (!usage) {
            const parsed = JSON.parse(responseBodyAccumulator);
            if (parsed.usage) usage = parsed.usage;
          }

          if (usage && requestedModel) {
            updateTokenStats(targetProvider.name, requestedModel, usage, ttfbMs);
          }
        } catch (e) {
          // Extraction failure doesn't affect proxy functionality
        }

        resolve(ttfbMs);
      });
    });

    proxyReq.on('error', err => {
      clearTimeout(ttfbTimer);
      reject(err);
    });

    proxyReq.on('timeout', () => {
      clearTimeout(ttfbTimer);
      proxyReq.destroy();
      reject(new Error('Request Timeout'));
    });

    proxyReq.write(bodyBuffer);
    proxyReq.end();
  });
}

// ==========================================
// HTTP Server + 路由
// ==========================================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Dashboard page
  if (req.method === 'GET' && req.url === '/dashboard') {
    const dashboardPath = path.join(__dirname, 'public', 'dashboard.html');
    fs.readFile(dashboardPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Dashboard not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // SSE real-time push endpoint
  if (req.method === 'GET' && req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(':\n\n'); // Initial heartbeat

    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // Initial state API
  if (req.method === 'GET' && req.url === '/api/init-state') {
    const today = localDateStr();

    // Build provider cooldown status
    const cooldownStatus = {};
    for (const [key, expiry] of cooldowns.entries()) {
      const [group, provider] = key.split(':');
      const k = `${group}_${provider}`;
      if (Date.now() < expiry) {
        cooldownStatus[k] = { group, provider, status: 'cooldown', expiry };
      }
    }

    // Build provider discount mapping (nested by modelGroup → provider)
    const discounts = {};
    for (const [groupName, providers] of Object.entries(config.modelGroups || {})) {
      discounts[groupName] = {};
      for (const p of providers) {
        if (p.discountRate !== undefined) discounts[groupName][p.name] = p.discountRate;
      }
    }
    discounts['default'] = {};
    for (const p of config.defaultProviders || []) {
      if (p.discountRate !== undefined) discounts['default'][p.name] = p.discountRate;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      today,
      stats: TokenStats,
      providers: cooldownStatus,
      velocity: calculateVelocity(),
      discounts,
      sparklines: getAllSparklines(),
      activityConfig: {
        windowMinutes: ACT_WINDOW_MIN,
        bucketMinutes: ACT_BUCKET_MIN,
        bucketCount: ACT_BUCKET_COUNT,
        pushIntervalMs: ACT_PUSH_INTERVAL
      }
    }));
    return;
  }

  // Proxy forwarding: POST /v1/messages
  if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
    const reqId = Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    const clientUserAgent = req.headers['user-agent'] || 'Unknown Client';
    logMessage('info', `\n📥 [${reqId}] Received request: ${req.method} ${req.url} (from: ${clientUserAgent})`, reqId);

    let bodyData = [];
    req.on('data', chunk => bodyData.push(chunk));
    req.on('end', async () => {
      const bodyBuffer = Buffer.concat(bodyData);
      let bodyJSON;
      try {
        bodyJSON = JSON.parse(bodyBuffer.toString());
      } catch (e) {
        return sendAnthropicError(res, 400, 'invalid_request_error', 'Invalid JSON body', reqId);
      }

      // Intercept and fix illegal empty text blocks from Claude Code (avoid upstream 400 error)
      if (bodyJSON.messages && Array.isArray(bodyJSON.messages)) {
        let modified = false;
        for (const msg of bodyJSON.messages) {
          if (msg.content && Array.isArray(msg.content)) {
            const originalLength = msg.content.length;
            msg.content = msg.content.filter(block => !(block.type === 'text' && block.text === ''));
            if (msg.content.length !== originalLength) {
              modified = true;
            }
          }
        }
        if (modified) {
          bodyData = [Buffer.from(JSON.stringify(bodyJSON))];
        }
      }

      // Log detailed request content to JSONL
      logToJSONL({
        reqId,
        type: 'request',
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: bodyJSON
      });

      const requestedModel = bodyJSON.model;
      if (!requestedModel) {
        return sendAnthropicError(res, 400, 'invalid_request_error', 'Missing required parameter: model', reqId);
      }

      // Identify and route by model groups
      let matchedGroupKey = 'default';
      let providersForModel = config.defaultProviders || [];

      for (const [groupName, providers] of Object.entries(config.modelGroups)) {
        // Support comma-separated model names in key (e.g., "sonnet,haiku")
        const modelNames = groupName.split(',').map(name => name.trim());
        const matched = modelNames.some(name =>
          requestedModel.toLowerCase().includes(name.toLowerCase())
        );
        if (matched) {
          matchedGroupKey = groupName;
          providersForModel = providers;
          break;
        }
      }

      if (providersForModel.length === 0) {
        return sendAnthropicError(res, 500, 'api_error', `Proxy misconfiguration: No providers found for group '${matchedGroupKey}'`, reqId);
      }

      logMessage('info', `🧭 [${reqId}] Model: ${requestedModel} => matched route group: [${matchedGroupKey}]`, reqId);

      // Filter providers in cooldown and attempt request (Fallback retry mechanism)
      let availableProviders = providersForModel.filter(p => !isProviderInCooldown(matchedGroupKey, p.name));

      if (availableProviders.length === 0) {
        logMessage('warn', `⚠️  [Warning] All providers in group [${matchedGroupKey}] are in cooldown, forcing retry!`, reqId);
        availableProviders = providersForModel;
      }

      let lastErrorMsg = '';
      const bufferToForward = Buffer.concat(bodyData);
      const requestStartTime = Date.now();

      for (let i = 0; i < availableProviders.length; i++) {
        const provider = availableProviders[i];

        const maxAttempts = config.maxAttemptsPerProvider || 2;
        let attempts = 0;

        while (attempts < maxAttempts) {
          attempts++;
          const attemptStartTime = Date.now();
          if (attempts === 1) {
            logMessage('info', `  -> [${i+1}/${availableProviders.length}] Trying provider: ${provider.name} (${provider.baseUrl})`, reqId);
          } else {
            logMessage('info', `  -> [${i+1}/${availableProviders.length}] 🔄 Retrying provider (attempt ${attempts}): ${provider.name}`, reqId);
          }

          try {
            const ttfbMs = await attemptProviderRequest(req, res, bufferToForward, provider, reqId, requestedModel);
            const totalElapsed = ((Date.now() - requestStartTime) / 1000).toFixed(2);
            const attemptElapsed = ((Date.now() - attemptStartTime) / 1000).toFixed(2);
            const ttfbSec = (ttfbMs / 1000).toFixed(2);
            logMessage('info', `  ✅ [Success] [${reqId}] Provider ${provider.name} responded. (TTFB: ${ttfbSec}s, attempt: ${attemptElapsed}s, total: ${totalElapsed}s)`, reqId);
            // Success: push provider active status
            proxyEvents.emit('provider_status', {
              group: matchedGroupKey,
              provider: provider.name,
              status: 'active',
              expiry: 0
            });
            return;
          } catch (err) {
            const attemptElapsed = ((Date.now() - attemptStartTime) / 1000).toFixed(2);
            logMessage('error', `  ❌ [Failed] [${reqId}] Provider ${provider.name} (attempt ${attempts}) error (elapsed: ${attemptElapsed}s): ${err.message}`, reqId);
            lastErrorMsg = err.message;

            // If response headers were already sent, we cannot retry
            if (res.headersSent) {
              logMessage('error', `  ⚠️  [${reqId}] Cannot retry - response already started`, reqId);
              return; // Exit early, response is already in progress
            }

            if (attempts < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        }

        setProviderCooldown(matchedGroupKey, provider.name);

        // If response has already started, we cannot try another provider
        if (res.headersSent) {
          logMessage('error', `  ⚠️  [${reqId}] Cannot fallback to next provider - response already started`, reqId);
          return;
        }

        if (i < availableProviders.length - 1) {
          logMessage('info', `  ⏭️  Preparing fallback to next provider...`, reqId);
        }
      }

      logMessage('error', `🚨 [Critical] [${reqId}] All providers in group [${matchedGroupKey}] failed!`, reqId);

      // Only send error response if we haven't already started sending a response
      if (!res.headersSent) {
        return sendAnthropicError(res, 502, 'api_error', `All providers for ${matchedGroupKey} failed. Last error: ${lastErrorMsg}`, reqId);
      }
    });
    return;
  }

  // Other routes — 404
  return sendAnthropicError(res, 404, 'not_found_error', 'Endpoint not found on proxy');
});

// ==========================================
// Smart port finding and server startup
// ==========================================
function startServer(port) {
  server.listen(port, () => {
    console.log(`===================================================`);
    console.log(`🚀 LLMux - Local LLM API Proxy started`);
    console.log(`✅ Listening on port: ${port}`);
    console.log(`\n📊 Dashboard: http://localhost:${port}/dashboard`);
    console.log(`\n🔌 Configure your client with:`);
    console.log(`\x1b[36mBase URL: http://localhost:${port}\x1b[0m`);
    console.log(`\x1b[36mAPI Key:  sk-ant-dummy-placeholder-key (or any valid format)\x1b[0m`);
    console.log(`===================================================`);
    console.log(`⏳ Waiting for client requests...`);

    // Auto-open dashboard in Chrome app mode (macOS only)
    if (process.platform === 'darwin') {
      const { exec } = require('child_process');
      const dashUrl = `http://localhost:${port}/dashboard`;

      // Check if dashboard is already open
      exec(`osascript -e 'tell application "Google Chrome" to get title of every tab of every window' 2>/dev/null`, (checkErr, stdout) => {
        if (stdout && stdout.includes('LLMux Dashboard')) {
          console.log(`📊 LLMux Dashboard already open`);
          return;
        }

        // Open in Chrome app mode
        exec(`/usr/bin/open -na "Google Chrome" --args --app="${dashUrl}"`, (openErr, openStdout, openStderr) => {
          if (openErr) {
            console.log(`📊 Chrome app mode failed, opening in default browser...`);
            exec(`open "${dashUrl}"`);
          } else {
            console.log(`📊 LLMux Dashboard opened in Chrome app mode`);
          }
        });
      });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      server.removeAllListeners('error');
      startServer(port + 1);
    } else {
      console.error('❌ Server startup failed:', err.message);
      process.exit(1);
    }
  });
}

const INITIAL_PORT = config.port || 34250;
startServer(INITIAL_PORT);
