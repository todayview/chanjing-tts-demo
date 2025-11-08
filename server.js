const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const API_BASE_URL = 'https://open-api.chanjing.cc';

// 配置CORS
const allowedOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'access_token'],
  credentials: true
}));

// 解析JSON请求体
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 配置multer用于文件上传
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// 静态文件服务 - 托管前端页面
app.use(express.static(__dirname));
// 静态托管上传目录
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const FormData = require('form-data');

// 文件上传并生成可访问链接（注册在代理和404之前）
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    console.log('[UPLOAD] receive file:', req.file?.originalname, req.file?.mimetype, req.file?.size);
    if (!req.file) {
      return res.status(400).json({ code: 400, msg: '未接收到文件' });
    }
    const original = req.file.originalname || `audio_${Date.now()}.wav`;
    const safeName = `${Date.now()}_${original.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    // 根据扩展名补全更准确的MIME类型
    const ext = (original.split('.').pop() || '').toLowerCase();
    let mime = req.file.mimetype || 'application/octet-stream';
    if (!mime || mime === 'application/octet-stream') {
      if (ext === 'mp3') mime = 'audio/mpeg';
      else if (ext === 'wav') mime = 'audio/wav';
      else if (ext === 'm4a') mime = 'audio/m4a';
    }

    try {
      const uploadUrl = `https://transfer.sh/${encodeURIComponent(safeName)}`;
      console.log('[UPLOAD] try transfer.sh:', uploadUrl, 'mime:', mime);
      const resp = await axios.put(uploadUrl, req.file.buffer, {
        headers: { 'Content-Type': mime },
        timeout: 30000,
      });
      const publicUrl = (typeof resp.data === 'string' ? resp.data : `${uploadUrl}`).trim();
      console.log('[UPLOAD] transfer.sh ok:', publicUrl);
      return res.json({ code: 0, data: { url: publicUrl, is_public: true }, msg: 'uploaded via transfer.sh' });
    } catch (e) {
      console.warn('[UPLOAD] transfer.sh failed:', e.message);
    }

    // 次级公网上传：0x0.st（简易公共文件托管）
    try {
      console.log('[UPLOAD] try 0x0.st fallback');
      const form = new FormData();
      form.append('file', req.file.buffer, { filename: safeName, contentType: mime });
      const resp2 = await axios.post('https://0x0.st', form, {
        headers: form.getHeaders(),
        timeout: 30000,
      });
      const txt = (typeof resp2.data === 'string' ? resp2.data : '').trim();
      console.log('[UPLOAD] 0x0.st response:', txt);
      if (txt.startsWith('http')) {
        return res.json({ code: 0, data: { url: txt, is_public: true }, msg: 'uploaded via 0x0.st' });
      } else {
        console.warn('[UPLOAD] 0x0.st returned non-url:', txt);
      }
    } catch (e) {
      console.warn('[UPLOAD] 0x0.st failed:', e.message);
    }

    // 本地回退（非公网）
    const uploadsDir = path.join(__dirname, 'uploads');
    try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch {}
    const targetPath = path.join(uploadsDir, safeName);
    fs.writeFileSync(targetPath, req.file.buffer);
    const localUrl = `http://localhost:${PORT}/uploads/${encodeURIComponent(safeName)}`;
    console.log('[UPLOAD] fallback local url:', localUrl);
    return res.json({ code: 0, data: { url: localUrl, is_public: false }, msg: '使用本地URL。远端无法访问本地，请重试以获取公网链接' });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    return res.status(500).json({ code: 50000, msg: '文件上传失败', error: err.message });
  }
});

// 代理中间件
async function proxyRequest(req, res, targetUrl) {
  try {
    console.log(`[PROXY] ${req.method} ${req.url} -> ${targetUrl}`);
    const config = {
      method: req.method,
      url: targetUrl,
      headers: {
        ...req.headers,
        'host': 'open-api.chanjing.cc',
        'origin': 'https://open-api.chanjing.cc',
        'referer': 'https://open-api.chanjing.cc/'
      },
      timeout: 30000
    };
    if (req.method === 'POST' && req.body) {
      config.data = req.body;
    }
    const response = await axios(config);
    Object.keys(response.headers).forEach(key => {
      if (key.toLowerCase() !== 'content-encoding') {
        res.setHeader(key, response.headers[key]);
      }
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error(`[PROXY ERROR] ${req.method} ${req.url}:`, error.message);
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else if (error.code === 'ENOTFOUND') {
      res.status(503).json({ code: 50000, msg: '无法连接到蝉镜API服务器，请检查网络连接', error: error.message });
    } else if (error.code === 'ECONNABORTED') {
      res.status(504).json({ code: 50000, msg: '请求超时，请稍后重试', error: error.message });
    } else {
      res.status(500).json({ code: 50000, msg: '代理服务器内部错误', error: error.message });
    }
  }
}

app.post('/proxy/access_token', async (req, res) => {
  const targetUrl = `${API_BASE_URL}/open/v1/access_token`;
  await proxyRequest(req, res, targetUrl);
});

app.post('/proxy/create_customised_audio', async (req, res) => {
  const targetUrl = `${API_BASE_URL}/open/v1/create_customised_audio`;
  await proxyRequest(req, res, targetUrl);
});

app.get('/proxy/customised_audio', async (req, res) => {
  const targetUrl = `${API_BASE_URL}/open/v1/customised_audio${req.url.replace('/proxy/customised_audio', '')}`;
  await proxyRequest(req, res, targetUrl);
});

app.post('/proxy/list_customised_audio', async (req, res) => {
  const targetUrl = `${API_BASE_URL}/open/v1/list_customised_audio`;
  await proxyRequest(req, res, targetUrl);
});

app.post('/proxy/create_audio_task', async (req, res) => {
  const targetUrl = `${API_BASE_URL}/open/v1/create_audio_task`;
  await proxyRequest(req, res, targetUrl);
});

app.get('/proxy/audio_task', async (req, res) => {
  try {
    const queryString = new URLSearchParams(req.query || {}).toString();
    const targetUrl = `${API_BASE_URL}/open/v1/audio_task${queryString ? `?${queryString}` : ''}`;
    await proxyRequest(req, res, targetUrl);
  } catch (e) {
    console.error('[AUDIO_TASK ROUTE ERROR]', e);
    res.status(500).json({ code: 50000, msg: '代理路由错误', error: e.message });
  }
});

// 新增：语音合成任务状态查询（支持 GET 与 POST）
app.get('/proxy/audio_task_state', async (req, res) => {
  try {
    const queryString = new URLSearchParams(req.query || {}).toString();
    const targetUrl = `${API_BASE_URL}/open/v1/audio_task_state${queryString ? `?${queryString}` : ''}`;
    await proxyRequest(req, res, targetUrl);
  } catch (e) {
    console.error('[AUDIO_TASK_STATE ROUTE ERROR]', e);
    res.status(500).json({ code: 50000, msg: '代理路由错误', error: e.message });
  }
});

app.post('/proxy/audio_task_state', async (req, res) => {
  const targetUrl = `${API_BASE_URL}/open/v1/audio_task_state`;
  await proxyRequest(req, res, targetUrl);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), message: '蝉镜API代理服务器运行正常' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 蝉镜API代理服务器启动成功！`);
  console.log(`📡 服务器地址: http://localhost:${PORT}`);
  console.log(`🌐 API代理地址: http://localhost:${PORT}/proxy/*`);
  console.log(`🏥 健康检查: http://localhost:${PORT}/health`);
  console.log('');
  console.log('✅ 请在浏览器中访问 http://localhost:3000 开始使用');
});

app.use((err, req, res, next) => {
  console.error(`[SERVER ERROR] ${req.method} ${req.url}:`, err);
  res.status(500).json({ code: 50000, msg: '服务器内部错误', error: err.message });
});

app.use((req, res) => {
  res.status(404).json({ code: 404, msg: '请求的接口不存在' });
});