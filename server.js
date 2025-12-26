const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const bs58 = require('bs58');

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_FILES = {
    'jin18': 'https://raw.githubusercontent.com/zhiim/moontv_api/main/jin18.json',
    'jingjian': 'https://raw.githubusercontent.com/zhiim/moontv_api/main/jingjian.json',
    'full': 'https://raw.githubusercontent.com/zhiim/moontv_api/main/LunaTV-config.json'
};

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10分钟缓存

const cacheCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cache) {
        if (now - value.time > CACHE_TTL) cache.delete(key);
    }
}, CACHE_TTL);

const FORMAT_CONFIG = {
    '0': { proxy: false, base58: false }, 'raw': { proxy: false, base58: false },
    '1': { proxy: true, base58: false }, 'proxy': { proxy: true, base58: false },
    '2': { proxy: false, base58: true }, 'base58': { proxy: false, base58: true },
    '3': { proxy: true, base58: true }, 'proxy-base58': { proxy: true, base58: true }
};

const EXCLUDE_HEADERS = new Set([
    'content-encoding', 'content-length', 'transfer-encoding',
    'connection', 'keep-alive', 'set-cookie', 'set-cookie2', 'host'
]);


// Base58 编码
function base58Encode(obj) {
    try {
        const str = JSON.stringify(obj);
        const bytes = Buffer.from(str); // Node.js 原生 Buffer
        return bs58.encode(bytes);
    } catch (e) {
        console.error("Base58 Encode Error:", e);
        return "";
    }
}

// 递归前缀替换
function addOrReplacePrefix(obj, newPrefix) {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix));
    const newObj = {};
    for (const key in obj) {
        if (key === 'api' && typeof obj[key] === 'string') {
            let apiUrl = obj[key];
            const urlIndex = apiUrl.indexOf('?url=');
            if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5);
            if (!apiUrl.startsWith(newPrefix)) apiUrl = newPrefix + apiUrl;
            newObj[key] = apiUrl;
        } else {
            newObj[key] = addOrReplacePrefix(obj[key], newPrefix);
        }
    }
    return newObj;
}

async function getRemoteJSON(sourceKey) {
    const url = SOURCE_FILES[sourceKey] || SOURCE_FILES['full'];
    const now = Date.now();
    
    // 检查缓存
    const cached = cache.get(sourceKey);
    if (cached && (now - cached.time < CACHE_TTL)) {
        return cached.data;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Node.js CORS Proxy',
                'Accept': 'application/json'
            }
        });

        clearTimeout(timeout);
        
        if (!response.ok) {
            throw new Error(`GitHub 返回 ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        // 更新缓存
        cache.set(sourceKey, { data, time: now });
        
        return data;
    } catch (err) {
        // 如果请求失败但有旧缓存，返回旧缓存
        if (cached) {
            console.warn(`GitHub 请求失败，使用缓存: ${err.message}`);
            return cached.data;
        }
        throw new Error(`无法获取配置文件: ${err.message}`);
    }
}


app.use(cors()); // 启用全域 CORS
// 解析 Body，用于 POST/PUT 代理
app.use(express.raw({ type: '*/*', limit: '100mb' }));

// 核心处理路由
app.all('/', async (req, res) => {
    let targetUrl = req.query.url;
    const format = req.query.format;
    const source = req.query.source || 'full';
    const prefix = req.query.prefix;

    const urlMatch = req.url.match(/[?&]url=([^&]+(?:&.*)?)/);
    if (urlMatch) {
        targetUrl = decodeURIComponent(urlMatch[1]);
    }

    // 获取当前协议和主机名，构建默认前缀
    // 注意：在反向代理(Nginx)后，req.protocol 可能是 http，需要信任代理配置
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const currentOrigin = `${protocol}://${host}`;
    const defaultPrefix = `${currentOrigin}/?url=`;

    try {
        // --- A. 代理模式 ---
        if (targetUrl) {
            // 1. 安全检查
            const isLocal = /^(https?:\/\/)(127\.|localhost|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|::1)/i.test(targetUrl);
            if (isLocal) {
                return res.status(403).json({ error: 'Access to local resources is forbidden' });
            }

            if (!/^https?:\/\//i.test(targetUrl)) {
                return res.status(400).json({ error: 'Invalid URL' });
            }
            try {
                const targetHost = new URL(targetUrl).host;
                if (targetHost === host) {
                    return res.status(400).json({ error: 'Loop detected' });
                }
            } catch {
                return res.status(400).json({ error: 'Invalid URL' });
            }

            // 2. 发起请求
            // 重新构建 Headers，去除可能引起问题的头
            const fetchHeaders = {};
            for (const [key, value] of Object.entries(req.headers)) {
                if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
                    fetchHeaders[key] = value;
                }
            }
            // 强制设置 Host 为目标域名
            // fetchHeaders['host'] = new URL(targetUrl).host; // node-fetch通常会自动处理

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 9000); // 9秒超时

            try {
                const proxyRes = await fetch(targetUrl, {
                    method: req.method,
                    headers: fetchHeaders,
                    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
                    signal: controller.signal,
                    redirect: 'follow'
                });

                // 3. 返回响应
                // 转发响应头
                for (const [key, value] of proxyRes.headers.entries()) {
                    if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
                        res.setHeader(key, value);
                    }
                }
                
                res.status(proxyRes.status);
                proxyRes.body.pipe(res); // 流式返回
                
            } catch (err) {
                if (err.name === 'AbortError') {
                    return res.status(504).json({ error: 'Gateway Timeout (9s limit)' });
                }
                throw err;
            } finally {
                clearTimeout(timeout);
            }
            return;
        }

        // --- B. 配置转换模式 ---
        if (format) {
            if (!SOURCE_FILES[source]) {
                return res.status(400).json({ error: 'Invalid source parameter' });
            }
            
            const config = FORMAT_CONFIG[format];
            if (!config) {
                return res.status(400).json({ error: 'Invalid format parameter' });
            }

            const rawData = await getRemoteJSON(source);
            
            // 处理前缀
            const newData = config.proxy
                ? addOrReplacePrefix(rawData, prefix || defaultPrefix)
                : rawData;

            // 编码输出
            if (config.base58) {
                const encoded = base58Encode(newData);
                res.setHeader('Content-Type', 'text/plain;charset=UTF-8');
                return res.send(encoded);
            } else {
                res.setHeader('Content-Type', 'application/json;charset=UTF-8');
                return res.json(newData);
            }
        }

        // --- C. 首页 (Help Page) ---
        const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API 中转代理服务</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .example { background: #e8f5e9; padding: 15px; border-left: 4px solid #4caf50; margin: 20px 0; }
    .section { background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 15px 0; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    table td { padding: 8px; border: 1px solid #ddd; }
    table td:first-child { background: #f5f5f5; font-weight: bold; width: 30%; }
  </style>
</head>
<body>
  <h1>🔄 API 中转代理服务</h1>
  <p>通用 API 中转代理，用于访问被墙或限制的接口。</p>
  
  <h2>使用方法</h2>
  <p>中转任意 API：在请求 URL 后添加 <code>?url=目标地址</code> 参数</p>
  <pre>${defaultPrefix}<示例API地址></pre>
  
  <h2>配置订阅参数说明</h2>
  <div class="section">
    <table>
      <tr>
        <td>format</td>
        <td><code>0</code> 或 <code>raw</code> = 原始 JSON<br>
            <code>1</code> 或 <code>proxy</code> = 添加代理前缀<br>
            <code>2</code> 或 <code>base58</code> = 原始 Base58 编码<br>
            <code>3</code> 或 <code>proxy-base58</code> = 代理 Base58 编码</td>
      </tr>
      <tr>
        <td>source</td>
        <td><code>jin18</code> = 精简版<br>
            <code>jingjian</code> = 精简版+成人<br>
            <code>full</code> = 完整版（默认）</td>
      </tr>
      <tr>
        <td>prefix</td>
        <td>自定义代理前缀（仅在 format=1 或 3 时生效）</td>
      </tr>
    </table>
  </div>
  
  <h2>配置订阅链接示例</h2>
    
  <div class="section">
    <h3>📦 精简版（jin18）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}/?format=0&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}/?format=1&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}/?format=2&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}/?format=3&source=jin18</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 精简版+成人（jingjian）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}/?format=0&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}/?format=1&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}/?format=2&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}/?format=3&source=jingjian</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 完整版（full，默认）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}/?format=0&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}/?format=1&source=full</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}/?format=2&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}/?format=3&source=full</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <h2>支持的功能</h2>
  <ul>
    <li>✅ 支持 GET、POST、PUT、DELETE 等所有 HTTP 方法</li>
    <li>✅ 自动转发请求头和请求体</li>
    <li>✅ 保留原始响应头（除敏感信息）</li>
    <li>✅ 完整的 CORS 支持</li>
    <li>✅ 超时保护（9 秒）</li>
    <li>✅ 支持 Base58 编码输出</li>
  </ul>
  
  <script>
    document.querySelectorAll('.copy-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const text = document.querySelectorAll('.copyable')[idx].innerText;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerText = '已复制！';
          setTimeout(() => (btn.innerText = '复制'), 1500);
        });
      });
    });
  </script>
</body>
</html>`;
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);

    } catch (err) {
        console.error('Server Error:', err);
        res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
});

// 健康检查
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
    console.log(`服务已启动: http://localhost:${PORT}`);
    console.log(`数据源目录: ${__dirname}`);
});

process.on('SIGTERM', () => {
    clearInterval(cacheCleanupInterval);
    console.log('清理完成，进程退出');
    process.exit(0);
});

process.on('SIGINT', () => {
    clearInterval(cacheCleanupInterval);
    console.log('清理完成，进程退出');
    process.exit(0);
});

