const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 映射 source 参数到本地文件名
const SOURCE_FILES = {
    'jin18': 'jin18.json',
    'jingjian': 'jingjian.json',
    'full': 'LunaTV-config.json' // 默认完整版
};

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

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Base58 编码
function base58Encode(obj) {
    const str = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(str); // 需要 Node 11+ 全局 TextEncoder 或 polyfill
    let intVal = 0n;
    for (let b of bytes) intVal = (intVal << 8n) + BigInt(b);
    let result = '';
    while (intVal > 0n) {
        const mod = intVal % 58n;
        result = BASE58_ALPHABET[Number(mod)] + result;
        intVal = intVal / 58n;
    }
    for (let b of bytes) {
        if (b === 0) result = BASE58_ALPHABET[0] + result;
        else break;
    }
    return result;
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

// 读取本地 JSON 文件
function getLocalJSON(sourceKey) {
    const fileName = SOURCE_FILES[sourceKey] || SOURCE_FILES['full'];
    const filePath = path.join(__dirname, fileName);

    return new Promise((resolve, reject) => {
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                console.error(`Error reading file ${fileName}:`, err);
                return reject(new Error('Source file not found or unreadable'));
            }
            try {
                resolve(JSON.parse(data));
            } catch (e) {
                reject(new Error('Invalid JSON in source file'));
            }
        });
    });
}


app.use(cors()); // 启用全域 CORS
// 解析 Body，用于 POST/PUT 代理
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// 核心处理路由
app.all('/', async (req, res) => {
    const targetUrl = req.query.url;
    const format = req.query.format;
    const source = req.query.source || 'full';
    const prefix = req.query.prefix;

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
            const config = FORMAT_CONFIG[format];
            if (!config) {
                return res.status(400).json({ error: 'Invalid format parameter' });
            }

            // 读取本地文件 (代替 getCachedJSON)
            const rawData = await getLocalJSON(source);
            
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
  <title>API 中转代理服务 (VPS版)</title>
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
  <h1>🔄 API 中转代理服务 <small style="font-size: 0.5em; color: #666">(VPS 私有部署)</small></h1>
  <p>通用 API 中转代理，用于访问被墙或限制的接口。数据源读取自 VPS 本地文件。</p>
  
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
    <li>✅ 本地文件直接读取（无 GitHub 延迟）</li>
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

