/**
 * MBTI 测评系统 - Node.js 一体化服务
 * 托管测试页面 + 代理飞书 API（解决跨域问题）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// 飞书配置
const APP_ID = 'cli_aa9799f4abfb9bd8';
const APP_SECRET = '93TOHe8RJcwCRMmYdP8InhsEsEXeqNV6';
const APP_TOKEN = 'Ixv9bL4HkasDCcsYCfnc2MLwnnh';
const TABLE_ID = 'tbl98yqaWVZeQXYT';

const PORT = process.env.PORT || 3001;

// 缓存 token
let cachedToken = null;
let tokenExpireAt = 0;

function getTenantToken() {
  return new Promise((resolve, reject) => {
    if (cachedToken && Date.now() < tokenExpireAt) {
      return resolve(cachedToken);
    }

    const body = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });
    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          cachedToken = result.tenant_access_token;
          tokenExpireAt = Date.now() + (result.expire - 300) * 1000;
          resolve(cachedToken);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function proxyFeishu(method, apiPath, reqBody, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      extraHeaders || {}
    );
    const options = {
      hostname: 'open.feishu.cn',
      path: apiPath,
      method: method,
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ code: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ code: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

async function writeToFeishu(recordData) {
  const token = await getTenantToken();
  const fields = {};

  for (const [key, value] of Object.entries(recordData)) {
    if (key === '测试时间') {
      fields[key] = Date.now();
    } else if (['E分值', 'I分值', 'S分值', 'N分值', 'T分值', 'F分值', 'J分值', 'P分值'].includes(key)) {
      fields[key] = parseInt(value) || 0;
    } else {
      fields[key] = String(value || '');
    }
  }

  const body = JSON.stringify({ fields });
  const result = await proxyFeishu(
    'POST',
    `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`,
    body,
    { 'Authorization': `Bearer ${token}` }
  );

  if (result.code === 200 && result.body.code === 0) {
    return {
      success: true,
      msg: '已成功提交到飞书智能表格！',
      record_id: result.body.data?.record?.record_id
    };
  } else {
    const errMsg = result.body?.msg || result.body?.error?.msg || '未知错误';
    throw new Error(errMsg);
  }
}

// MIME 类型
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // API 路由
  if (req.method === 'POST' && pathname === '/submit') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const result = await writeToFeishu(data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        console.log('[OK]', data.姓名, '-', data.人格类型);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, msg: e.message }));
        console.log('[FAIL]', e.message);
      }
    });
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ status: 'ok', service: 'MBTI-Cloud' }));
  }

  // 静态文件服务
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  // 安全检查
  if (filePath.includes('..')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('MBTI Cloud Service running on port', PORT);
});
