const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');


function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    });
  } catch (e) {}
}
loadDotEnv();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const EXAMS_DIR = path.join(__dirname, 'public', 'exams');

if (!fs.existsSync(EXAMS_DIR)) {
  fs.mkdirSync(EXAMS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const pubIdx = path.join(__dirname, 'public', 'index.html');
  const rootIdx = path.join(__dirname, 'index.html');
  res.sendFile(fs.existsSync(pubIdx) ? pubIdx : rootIdx);
});

function readDb() {
  if (!fs.existsSync(DB_FILE)) return { accounts: {}, examFiles: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { accounts: parsed.accounts || {}, examFiles: parsed.examFiles || {} };
  } catch (e) {
    return { accounts: {}, examFiles: {} };
  }
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function getSupabaseCfg() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_KEY || '').trim();
  return (url.startsWith('https://') && key) ? { url, key } : null;
}

function getSupabaseHeaders(key, extra = {}) {
  const h = { apikey: key, ...extra };
  if (key.startsWith('eyJ')) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

async function dbGetAccount(userId) {
  const sb = getSupabaseCfg();
  if (sb) {
    try {
      const r = await fetch(`${sb.url}/rest/v1/tutor_accounts?user_id=eq.${encodeURIComponent(userId)}&select=*`, {
        headers: getSupabaseHeaders(sb.key)
      });
      if (r.ok) {
        const rows = await r.json();
        if (Array.isArray(rows) && rows[0]) {
          return { name: rows[0].name, pw: rows[0].pw, state: rows[0].state || {} };
        }
        return null;
      } else {
        const errTxt = await r.text().catch(() => '');
        console.error('[Supabase GET] HTTP', r.status, errTxt.slice(0, 200));
      }
    } catch (e) {
      console.error('[Supabase GET]', e.message);
    }
  }
  const db = readDb();
  return db.accounts[userId] || null;
}

async function dbSaveAccount(userId, accountObj) {
  const sb = getSupabaseCfg();
  if (sb) {
    try {
      const r = await fetch(`${sb.url}/rest/v1/tutor_accounts`, {
        method: 'POST',
        headers: getSupabaseHeaders(sb.key, {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        }),
        body: JSON.stringify({
          user_id: userId,
          name: accountObj.name || userId,
          pw: accountObj.pw || '',
          state: accountObj.state || {},
          updated_at: new Date().toISOString()
        })
      });
      if (r.ok) return true;
      const errTxt = await r.text().catch(() => '');
      console.error('[Supabase UPSERT] HTTP', r.status, errTxt.slice(0, 200));
    } catch (e) {
      console.error('[Supabase UPSERT]', e.message);
    }
  }
  const db = readDb();
  db.accounts[userId] = {
    name: accountObj.name || userId,
    pw: accountObj.pw || '',
    state: accountObj.state || {},
    updatedAt: new Date().toISOString()
  };
  writeDb(db);
  return true;
}

// 1. 영구 중앙 DB (Supabase 연동 시 재배포에도 유지) 회원가입 / 로그인 / 상태 동기화
app.post('/api/signup', async (req, res) => {
  const { userId, name, pw, state } = req.body || {};
  if (!userId || !pw) return res.status(400).json({ error: '아이디와 비밀번호가 필요합니다.' });
  const existing = await dbGetAccount(userId);
  if (existing) return res.status(409).json({ error: '이미 있는 아이디입니다. 다른 아이디를 사용하거나 로그인해 주세요.' });
  await dbSaveAccount(userId, { name: name || userId, pw, state: state || {} });
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const { userId, pw } = req.body || {};
  const acc = await dbGetAccount(userId);
  if (!acc) return res.status(404).json({ error: '등록되지 않은 아이디입니다.' });
  if (acc.pw && acc.pw !== pw) return res.status(401).json({ error: '비밀번호가 일치하지 않습니다.' });
  res.json({ ok: true, name: acc.name, state: acc.state });
});

app.put('/api/state/:userId', async (req, res) => {
  const { userId } = req.params;
  const existing = await dbGetAccount(userId);
  const nextAcc = {
    name: (req.body && req.body.name) || (existing && existing.name) || userId,
    pw: (req.body && req.body.pw) || (existing && existing.pw) || '',
    state: (req.body && req.body.state) || (existing && existing.state) || {}
  };
  await dbSaveAccount(userId, nextAcc);
  res.json({ ok: true });
});

app.get('/api/state/:userId', async (req, res) => {
  const { userId } = req.params;
  const acc = await dbGetAccount(userId);
  if (!acc) return res.status(404).json({ ok: false });
  res.json({ ok: true, name: acc.name, state: acc.state || {} });
});

const ANIME_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="55%" stop-color="#8b5cf6"/>
      <stop offset="100%" stop-color="#ec4899"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="76" y="102" width="360" height="248" rx="34" fill="#eef2ff" stroke="#1e1b4b" stroke-width="18"/>
  <rect x="104" y="130" width="304" height="178" rx="18" fill="#ffffff"/>
  <rect x="126" y="152" width="122" height="132" rx="14" fill="#e0e7ff" stroke="#4f46e5" stroke-width="8"/>
  <line x1="148" y1="184" x2="226" y2="184" stroke="#4f46e5" stroke-width="10" stroke-linecap="round"/>
  <line x1="148" y1="214" x2="212" y2="214" stroke="#6366f1" stroke-width="10" stroke-linecap="round"/>
  <line x1="148" y1="244" x2="198" y2="244" stroke="#818cf8" stroke-width="10" stroke-linecap="round"/>
  <rect x="274" y="220" width="28" height="64" rx="8" fill="#34d399"/>
  <rect x="316" y="190" width="28" height="94" rx="8" fill="#f472b6"/>
  <rect x="358" y="162" width="28" height="122" rx="8" fill="#6366f1"/>
  <path d="M220 350h72l16 46H204z" fill="#c7d2fe" stroke="#1e1b4b" stroke-width="14" stroke-linejoin="round"/>
  <line x1="166" y1="404" x2="346" y2="404" stroke="#1e1b4b" stroke-width="18" stroke-linecap="round"/>
  <path d="M426 62l10 24 24 10-24 10-10 24-10-24-24-10 24-10z" fill="#fde047"/>
</svg>`;

app.get('/favicon.ico', (req, res) => { res.redirect(302, '/icon-192.png?v=5'); });

app.get('/icon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(ANIME_ICON_SVG);
});

app.get(['/icon-192.png', '/icon-512.png'], (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  next();
});

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.json({
    id: '/?v=5',
    name: '학생관리 - 과외 관리',
    short_name: '학생관리',
    description: '과외 학생 글 첨삭 요약, 진도, 출결, 학부모 안내 통합 앱',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#6366f1',
    icons: [
      { src: '/icon-192.png?v=5', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png?v=5', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon.svg?v=5', sizes: 'any', type: 'image/svg+xml' }
    ]
  });
});

// 2. 호랭이닷컴에서 해당 대학·연도 논술 PDF 직링크 자동 추출
app.get('/api/horaeng-pdfs', async (req, res) => {
  const { univ = '', year = '', track = '', session = '' } = req.query;
  const queries = [`${univ} ${year} 선행학습`, `${univ} ${year} 논술`];
  let searchUrl = `https://horaeng.com/?s=${encodeURIComponent(queries[0])}`;
  const fetchWithShortTimeout = async (urlStr) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4500);
    try {
      const r = await fetch(urlStr, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: ac.signal
      });
      clearTimeout(t);
      if (!r.ok) return '';
      return await r.text();
    } catch (e) {
      clearTimeout(t);
      return '';
    }
  };
  const TISTORY_ARCHIVE_MAP = {
    '서강대_2020': 'https://karis.tistory.com/132',
    '서강대_2021': 'https://karis.tistory.com/133',
    '중앙대_2020': 'https://karis.tistory.com/107',
    '중앙대_2021': 'https://karis.tistory.com/107',
    '연세대_2021': 'https://sayruru.tistory.com/93',
    '성균관대_2021': 'https://sayruru.tistory.com/93',
    '한양대_2021': 'https://sayruru.tistory.com/93',
    '서강대_2021_alt': 'https://sayruru.tistory.com/93'
  };
  try {
    let pdfMatches = [];
    let postUrl = '';
    const archiveUrl = TISTORY_ARCHIVE_MAP[`${univ}_${year}`] || TISTORY_ARCHIVE_MAP[`${univ}_${year}_alt`];
    if (archiveUrl) {
      const tHtml = await fetchWithShortTimeout(archiveUrl);
      if (tHtml) {
        const tLinks = [...tHtml.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
          .map(m => ({ url: m[1], label: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
          .filter(x => /\.pdf/i.test(x.url) || /\.pdf/i.test(x.label));
        const filtered = tLinks.filter(x =>
          (x.label.includes(year) || x.url.includes(year) || archiveUrl !== 'https://sayruru.tistory.com/93') &&
          (!archiveUrl.includes('sayruru') || x.label.includes(univ.replace('학교', '')))
        );
        if (filtered.length > 0) {
          postUrl = archiveUrl;
          pdfMatches = filtered;
        }
      }
    }
    if (pdfMatches.length === 0) for (const q of queries) {
      searchUrl = `https://horaeng.com/?s=${encodeURIComponent(q)}`;
      const searchHtml = await fetchWithShortTimeout(searchUrl);
      if (!searchHtml) continue;
      const postMatches = [...searchHtml.matchAll(/href=["'](https:\/\/horaeng\.com\/[^"']+)["']/gi)]
        .map(m => m[1])
        .filter(u => !u.includes('/category/') && !u.includes('/tag/') && !u.includes('?s=') && !u.includes('/wp-') && u !== 'https://horaeng.com/');
      for (const candidateUrl of [...new Set(postMatches)].slice(0, 2)) {
        const postHtml = await fetchWithShortTimeout(candidateUrl);
        if (!postHtml) continue;
        const found = [...postHtml.matchAll(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi)]
          .map(m => ({
            url: m[1].startsWith('http') ? m[1] : new URL(m[1], candidateUrl).href,
            label: m[2].replace(/<[^>]+>/g, '').trim() || '논술 기출/해설 PDF'
          }));
        if (found.length > 0) {
          postUrl = candidateUrl;
          pdfMatches = found;
          break;
        }
      }
      if (pdfMatches.length > 0) break;
    }

    if (pdfMatches.length === 0) {
      return res.json({ ok: false, searchUrl, postUrl });
    }

    const filterByTrackSession = (items) => {
      const keywords = [];
      if (track.includes('상경') || track.includes('경영') || track.includes('사회')) keywords.push('상경', '사회', '경영');
      if (track.includes('인문')) keywords.push('인문');
      if (session.includes('오전') || session.includes('1교시') || session.includes('1차') || session.includes('1부')) keywords.push('오전', '1교시', '1차', '1부');
      if (session.includes('오후') || session.includes('2교시') || session.includes('2차') || session.includes('2부')) keywords.push('오후', '2교시', '2차', '2부');
      const matched = items.filter(it => keywords.some(k => it.label.includes(k) || decodeURIComponent(it.url).includes(k)));
      return matched.length > 0 ? matched : items;
    };

    const candidates = filterByTrackSession(pdfMatches);
    const passageItem = candidates.find(c => /(문제|제시문|논제)/i.test(c.label + decodeURIComponent(c.url))) || candidates[0];
    const guideItem = candidates.find(c => /(해설|답안|예시|채점)/i.test(c.label + decodeURIComponent(c.url))) || candidates[1] || passageItem;

    res.json({
      ok: true,
      postUrl,
      passageUrl: passageItem ? passageItem.url : '',
      guideUrl: guideItem ? guideItem.url : '',
      allPdfs: pdfMatches
    });
  } catch (err) {
    res.json({ ok: false, searchUrl });
  }
});

// 3. PDF 프록시 & 즉시 다운로드 (?download=1 이면 사이트 이동 없이 바로 .pdf 파일 다운로드)
const httpMod = require('http');
const httpsMod = require('https');

function fetchBinaryWithTlsBypass(urlStr, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(e); }
    const mod = parsed.protocol === 'https:' ? httpsMod : httpMod;
    const reqOpts = {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,application/octet-stream,*/*;q=0.8',
        'Referer': `${parsed.origin}/`
      },
      rejectUnauthorized: false,
      timeout: 25000
    };
    const r = mod.request(parsed, reqOpts, (resp) => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location && redirectsLeft > 0) {
        resp.resume();
        const nextUrl = new URL(resp.headers.location, parsed).href;
        return resolve(fetchBinaryWithTlsBypass(nextUrl, redirectsLeft - 1));
      }
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode || 200, headers: resp.headers, buffer: Buffer.concat(chunks) }));
    });
    r.on('timeout', () => { r.destroy(new Error('PDF 요청 시간 초과')); });
    r.on('error', reject);
    r.end();
  });
}

app.get('/api/pdf-proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const isDownload = req.query.download === '1';
  const fileName = (req.query.name || 'essay_exam').replace(/[^a-zA-Z0-9가-힣._-]/g, '_') + '.pdf';

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).send('유효한 PDF URL이 필요합니다.');
  }
  try {
    const upstream = await fetchBinaryWithTlsBypass(targetUrl);
    if (upstream.status < 200 || upstream.status >= 400) {
      return res.status(upstream.status).send('PDF를 불러오지 못했습니다.');
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', isDownload ? `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}` : 'inline');
    res.send(upstream.buffer);
  } catch (err) {
    console.error('[PDF Proxy]', targetUrl, err.message);
    res.status(502).send('PDF 서버 연결에 실패했습니다.');
  }
});


// 4. 사진 반영하기 & 첨삭 분석 (Render 환경변수 GEMINI_API_KEY 사용 — 브라우저에 절대 노출되지 않음)
app.get('/api/health', async (req, res) => {
  const hasApiKey = Boolean((process.env.GEMINI_API_KEY || '').trim());
  const sb = getSupabaseCfg();
  let supabaseOk = false;
  let supabaseError = '';
  if (sb) {
    try {
      const r = await fetch(`${sb.url}/rest/v1/tutor_accounts?select=user_id&limit=1`, {
        headers: getSupabaseHeaders(sb.key)
      });
      if (r.ok) supabaseOk = true;
      else {
        const errBody = await r.text().catch(() => '');
        supabaseError = `HTTP ${r.status} (${sb.key.slice(0, 6)}..len=${sb.key.length}): ${errBody.slice(0, 140)}`;
      }
    } catch (e) {
      supabaseError = e.message;
    }
  } else {
    supabaseError = 'SUPABASE_URL 또는 SUPABASE_KEY 미설정';
  }
  res.json({ ok: true, hasApiKey, hasSupabase: Boolean(sb), supabaseOk, supabaseError });
});

async function discoverAvailableGeminiModels(apiKey) {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if (!r.ok) return [];
    const data = await r.json();
    const list = (data.models || [])
      .filter(m =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent') &&
        !/tts|embedding|imagen|veo|lyria|audio|live|robotics|transcribe|aqa/i.test(m.name || '')
      )
      .map(m => (m.name || '').replace(/^models\//, ''));
    const score = (id) => {
      let s = 0;
      if (id.includes('gemini-4')) s += 400;
      else if (id.includes('gemini-3.8')) s += 380;
      else if (id.includes('gemini-3.5')) s += 350;
      else if (id.includes('gemini-3')) s += 300;
      else if (id.includes('gemini-2.5')) s += 250;
      if (id.includes('pro') || id.includes('carbon') || id.includes('neon')) s += 40;
      if (id.includes('flash') && !id.includes('lite')) s += 25;
      if (id.includes('hydrogen')) s += 20;
      return s;
    };
    return [...new Set(list)].sort((a, b) => score(b) - score(a));
  } catch (e) {
    return [];
  }
}

const CACHED_MODELS = { vision: '', chat: '' };

async function callGeminiWithFallback(apiKey, bodyObj, mode = 'vision') {
  const preferred = mode === 'chat'
    ? ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-hydrogen', 'gemini-3.5-flash', 'gemini-4-carbon', 'gemini-4-neon', 'gemini-4-argon']
    : ['gemini-3.8-flash', 'gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];

  const order = CACHED_MODELS[mode]
    ? [CACHED_MODELS[mode], ...preferred.filter(m => m !== CACHED_MODELS[mode])]
    : preferred;

  const errors = [];
  const tryModel = async (model) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (r.ok) {
        const data = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) {
          CACHED_MODELS[mode] = model;
          return { text, model, error: '' };
        }
        errors.push(`${model}: 빈 응답`);
      } else {
        const errBody = await r.text().catch(() => '');
        console.error(`[Gemini ${model}] HTTP ${r.status}`, errBody.slice(0, 200));
        errors.push(`${model}: HTTP ${r.status}`);
      }
    } catch (err) {
      clearTimeout(timer);
      console.error(`[Gemini ${model}] Error:`, err.message);
      errors.push(`${model}: ${err.name === 'AbortError' ? '시간 초과' : err.message}`);
    }
    return null;
  };

  for (const model of order) {
    const ok = await tryModel(model);
    if (ok) return ok;
    await new Promise(r => setTimeout(r, 750));
  }

  const discovered = await discoverAvailableGeminiModels(apiKey);
  for (const model of discovered.filter(m => !order.includes(m)).slice(0, 5)) {
    const ok = await tryModel(model);
    if (ok) return ok;
  }

  return { text: '', model: '', error: errors.join(' / ') };
}

app.post('/api/reflect-photos', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const { passageImages = [], guideImages = [], note = '' } = req.body || {};
  if (!apiKey) {
    return res.json({ ok: false, reason: 'Render Environment Variables에 GEMINI_API_KEY가 설정되지 않았습니다.' });
  }
  try {
    const parts = [{
      text: `당신은 대한민국 최상위권 대입 인문논술 전문 선생님 보조입니다.
첨부된 제시문·해설·논제 이미지와 선생님 메모("${note}")를 작은 글자·각주·도표·수치까지 한 글자도 빠뜨리지 말고 정밀하게 판독한 뒤, 수업과 첨삭에 바로 활용할 수 있도록 아래 형식에 맞춰 **구체적이고 상세하게** 정리하세요.

[핵심 개념어]
- 제시문과 논제를 관통하는 주요 개념어 6~10개 (쉼표로 구분)

[제시문별 상세 요약]
- (가), (나), (다) 등 각 제시문마다 중심 주장, 논거(사례/실험/이론), 핵심 전제와 결론을 3~5문장으로 상세히 서술

[제시문 간 관계 및 대립·연결 구도]
- 제시문들 사이의 공통점·차이점, 대립 축, 또는 한 제시문이 다른 제시문을 어떻게 설명·비판·보완하는지 구조적으로 정리

[질문(논제) 요구사항 및 작성 조건]
- 문항별([문제 1], [문제 2] 등) 요구 행위(요약, 비교·대조, 비판·평가, 적용 등), 글자 수 분량, 배점 및 세부 조건을 빠짐없이 정리

[해설 및 채점기준 핵심 포인트]
- 모범 답안의 논리 전개 방향, 반드시 포함해야 할 핵심 논점, 학생이 흔히 놓치는 감점 주의사항`
    }];
    [...passageImages, ...guideImages].forEach(img => {
      if (img && img.dataUrl && img.dataUrl.includes(',')) {
        parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.dataUrl.split(',')[1] } });
      }
    });
    const result = await callGeminiWithFallback(apiKey, {
      contents: [{ parts }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
    }, 'vision');
    if (result.text) {
      return res.json({ ok: true, summary: result.text, model: result.model });
    }
    res.json({ ok: false, reason: result.error || 'AI 모델 응답 실패' });
  } catch (e) {
    res.json({ ok: false, reason: e.message || '서버 처리 오류' });
  }
});

app.post('/api/analyze-essay', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const { studentText = '', feedbackText = '', promptSummary = '' } = req.body || {};
  if (!apiKey) return res.json({ ok: false, reason: 'NO_API_KEY' });
  try {
    const prompt = `당신은 대입 인문논술 과외 선생님 보조입니다. 아래 [반영된 제시문·논제 요약], [학생의 글], [선생님 첨삭]을 바탕으로 JSON만 반환하세요.

[분석 지침]
1. [반영된 제시문·논제 요약]이 있을 경우, 그 안에 정리된 제시문 핵심 논지, 논제 요구사항(요약·비교·비판 등), 채점기준을 기준으로 학생 글이 어떤 포인트를 잘 짚었는지(strengths)와 어떤 조건/논점을 놓쳤거나 어긋났는지(weaknesses)를 반드시 직접 연결해 구체적으로 작성하세요.
2. tags(약점 유형 태그, 2~4개) 작성 규칙:
   - 제시문이나 학생 글의 소재·주제어(예: '플랫폼 노동자', '노동자성 인정', '인공지능', '자유주의' 등 본문 내용 명사)는 **절대** 넣지 마세요.
   - '논리 전개', '글쓰기 부족', '전반적 미흡' 같은 **포괄적·추상적 표현도 금지**합니다.
   - 반드시 다음처럼 **구체적인 글쓰기·논술 약점 유형**만 4~10자 내외로 뽑으세요:
     예시: '어휘력 미흡', '사례 누락', '근거 불충분', '인과 비약', '문장 호응 오류', '구어체·비문', '논제 조건 누락', '비교 기준 불명확', '제시문 요약 편향', '주장·근거 불일치', '개념어 오용', '반론 고려 미흡', '맞춤법·시제 오류', '결론 단정적 서술', '분량 조절 실패'

키: strengths(문자열 배열 2~4개), weaknesses(문자열 배열 2~4개), tags(문자열 배열 2~4개), actionPlan(다음 수업 처방 한두 문장).

[반영된 제시문·논제 요약]
${promptSummary || '(없음)'}

[학생의 글]
${studentText}

[선생님 첨삭]
${feedbackText}`;
    const result = await callGeminiWithFallback(apiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    }, 'chat');
    if (!result.text) return res.json({ ok: false, reason: result.error });
    const parsed = JSON.parse(result.text);
    if (Array.isArray(parsed.strengths) && Array.isArray(parsed.weaknesses)) {
      return res.json({ ok: true, result: parsed });
    }
    res.json({ ok: false, reason: 'JSON 파싱 실패' });
  } catch (e) {
    res.json({ ok: false, reason: e.message });
  }
});


// 5. jace48 전용 논술 대화 · 자료 학습(이미지/PDF) · 제시문/문제 제작 AI 채팅
app.post('/api/essay-studio-chat', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const { userId = '', targetUniv = '연세대', univMeta = '', messages = [], sourceRef = '', attachments = [] } = req.body || {};
  if (String(userId).trim().toLowerCase() !== 'jace48') {
    return res.status(403).json({ ok: false, reason: '접근 권한이 없는 계정입니다.' });
  }
  if (!apiKey) {
    return res.json({ ok: false, reason: 'Render Environment Variables에 GEMINI_API_KEY가 설정되지 않았습니다.' });
  }
  try {
    const sysPrompt = `당신은 대한민국 최상위권 대입 인문논술(특히 ${targetUniv}) 전문 파트너이자 제시문·문항·읽기자료 제작 AI 어시스턴트입니다.
현재 선택된 대학 채팅방: ${targetUniv}
대학별 출제 특성: ${univMeta || '해당 대학 인문논술 기출 스타일'}

[대화 및 작업 원칙]
1. 유연한 대화와 학습:
   - 사용자가 가벼운 질문, 수업 고민, 출제 방향 상의 등 일반 대화를 건네면 딱딱한 템플릿을 강요하지 말고 자연스럽고 명쾌한 한국어로 대화하세요.
   - 사용자가 이미지나 PDF 자료를 첨부해 학습·분석을 요청하면, 첨부 파일의 문체, 논지, 출제 구조, 핵심 개념을 정밀하게 파악하고 요약해 이후 대화·제작에 계속 반영하세요.
2. 제시문·문제·읽기자료 제작 요청 시:
   - 시중 칼럼·책·기사 원문을 단순 복붙하지 말고, ${targetUniv} 실제 기출 특유의 압축적이고 개념적인 학술·비평 문체로 재가공하세요.
   - 필요에 따라 [제시문 (가)/(나)/(다)...], [논제], [출제 의도 및 채점기준], [예시 답안] 또는 [논술 대비 읽기 자료]를 완성도 높게 작성하세요.
   - 후속 수정 요청에는 앞선 대화 맥락과 학습한 자료를 바탕으로 해당 부분만 정밀하게 다듬어 주세요.` + (sourceRef ? `\n\n[사용자가 첨부한 참고 출처/원문]\n${sourceRef}` : '');

    const rawMsgs = Array.isArray(messages) ? messages.slice(-16) : [];
    const contents = [];
    rawMsgs.forEach((m, i) => {
      if (!m || !m.text) return;
      const parts = [{ text: String(m.text) }];
      // Attach uploaded image/PDF inline_data to the latest user message
      if (i === rawMsgs.length - 1 && m.role !== 'model' && Array.isArray(attachments)) {
        attachments.forEach(att => {
          if (att && att.dataUrl && att.dataUrl.includes(',')) {
            parts.push({
              inline_data: {
                mime_type: att.mimeType || 'image/jpeg',
                data: att.dataUrl.split(',')[1]
              }
            });
          }
        });
      }
      contents.push({
        role: m.role === 'model' ? 'model' : 'user',
        parts
      });
    });

    if (contents.length === 0) {
      return res.status(400).json({ ok: false, reason: '대화 내용이 비어 있습니다.' });
    }

    const mode = (Array.isArray(attachments) && attachments.length > 0) ? 'vision' : 'chat';
    const result = await callGeminiWithFallback(apiKey, {
      systemInstruction: { parts: [{ text: sysPrompt }] },
      contents
    }, mode);

    if (result.text) {
      return res.json({ ok: true, reply: result.text, model: result.model });
    }
    res.json({ ok: false, reason: result.error || 'AI 응답 생성 실패' });
  } catch (e) {
    res.json({ ok: false, reason: e.message || '서버 오류' });
  }
});


async function dbListAllRows() {
  const sb = getSupabaseCfg();
  if (sb) {
    try {
      const r = await fetch(`${sb.url}/rest/v1/tutor_accounts?select=*`, {
        headers: getSupabaseHeaders(sb.key)
      });
      if (r.ok) {
        const rows = await r.json();
        if (Array.isArray(rows)) return rows;
      }
    } catch (e) {
      console.error('[Supabase LIST]', e.message);
    }
  }
  const db = readDb();
  return Object.entries(db.accounts || {}).map(([user_id, v]) => ({
    user_id,
    name: v.name || user_id,
    pw: v.pw || '',
    state: v.state || {},
    updated_at: v.updatedAt || new Date().toISOString()
  }));
}

async function dbDeleteAccount(userId) {
  const sb = getSupabaseCfg();
  if (sb) {
    try {
      await fetch(`${sb.url}/rest/v1/tutor_accounts?user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: getSupabaseHeaders(sb.key)
      });
    } catch (e) {
      console.error('[Supabase DELETE]', e.message);
    }
  }
  const db = readDb();
  if (db.accounts && db.accounts[userId]) {
    delete db.accounts[userId];
    writeDb(db);
  }
  return true;
}

// 6. 공지사항 CRUD (jace48 작성/수정/삭제, 전체 열람)
app.get('/api/notices', async (req, res) => {
  const rec = await dbGetAccount('__sys_notices__');
  const notices = (rec && rec.state && Array.isArray(rec.state.notices)) ? rec.state.notices : [];
  res.json({ ok: true, notices });
});

app.post('/api/notices', async (req, res) => {
  const { userId = '', title = '', body = '' } = req.body || {};
  if (String(userId).trim().toLowerCase() !== 'jace48') return res.status(403).json({ ok: false });
  if (!title.trim() || !body.trim()) return res.status(400).json({ ok: false });
  const rec = await dbGetAccount('__sys_notices__');
  const notices = (rec && rec.state && Array.isArray(rec.state.notices)) ? rec.state.notices : [];
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const kr = new Date(now.getTime() + 9 * 3600 * 1000);
  const createdAt = `${kr.getUTCFullYear()}-${pad(kr.getUTCMonth() + 1)}-${pad(kr.getUTCDate())} ${pad(kr.getUTCHours())}:${pad(kr.getUTCMinutes())}`;
  notices.unshift({ id: 'n-' + Date.now(), title: title.trim(), body: body.trim(), createdAt, updatedAt: '' });
  await dbSaveAccount('__sys_notices__', { name: 'SYSTEM_NOTICES', pw: '', state: { notices } });
  res.json({ ok: true, notices });
});

app.put('/api/notices/:id', async (req, res) => {
  const { userId = '', title = '', body = '' } = req.body || {};
  if (String(userId).trim().toLowerCase() !== 'jace48') return res.status(403).json({ ok: false });
  const rec = await dbGetAccount('__sys_notices__');
  const notices = (rec && rec.state && Array.isArray(rec.state.notices)) ? rec.state.notices : [];
  const target = notices.find(n => n.id === req.params.id);
  if (!target) return res.status(404).json({ ok: false });
  if (title.trim()) target.title = title.trim();
  if (body.trim()) target.body = body.trim();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const kr = new Date(now.getTime() + 9 * 3600 * 1000);
  target.updatedAt = `${kr.getUTCFullYear()}-${pad(kr.getUTCMonth() + 1)}-${pad(kr.getUTCDate())} ${pad(kr.getUTCHours())}:${pad(kr.getUTCMinutes())}`;
  await dbSaveAccount('__sys_notices__', { name: 'SYSTEM_NOTICES', pw: '', state: { notices } });
  res.json({ ok: true, notices });
});

app.delete('/api/notices/:id', async (req, res) => {
  const userId = req.query.userId || (req.body && req.body.userId) || '';
  if (String(userId).trim().toLowerCase() !== 'jace48') return res.status(403).json({ ok: false });
  const rec = await dbGetAccount('__sys_notices__');
  const notices = ((rec && rec.state && Array.isArray(rec.state.notices)) ? rec.state.notices : []).filter(n => n.id !== req.params.id);
  await dbSaveAccount('__sys_notices__', { name: 'SYSTEM_NOTICES', pw: '', state: { notices } });
  res.json({ ok: true, notices });
});

// 7. 시스템 상태(점검 모드), 하트비트, 다른 계정 오류 수집 & jace48 개발자 모드
const ONLINE_HEARTBEATS = {};

app.post('/api/heartbeat', (req, res) => {
  const { userId = '' } = req.body || {};
  if (userId) ONLINE_HEARTBEATS[userId] = Date.now();
  res.json({ ok: true });
});

app.get('/api/system-status', async (req, res) => {
  const userId = String(req.query.userId || '').trim().toLowerCase();
  const rec = await dbGetAccount('__sys_maintenance__');
  const st = (rec && rec.state) ? rec.state : {};
  let status = st.status || (st.enabled ? 'active' : 'idle');
  let startAt = Number(st.startAt || 0);
  let endedAt = Number(st.endedAt || 0);
  if (status === 'scheduled' && startAt > 0 && Date.now() >= startAt) {
    status = 'active';
    await dbSaveAccount('__sys_maintenance__', { name: 'SYSTEM_MAINTENANCE', pw: '', state: { status: 'active', startAt, endedAt: 0 } });
  }
  const isActive = status === 'active';
  res.json({
    ok: true,
    status,
    startAt,
    endedAt,
    maintenance: isActive,
    blocked: isActive && userId !== 'jace48'
  });
});

app.post('/api/admin/maintenance', async (req, res) => {
  const { userId = '', enabled = false } = req.body || {};
  if (String(userId).trim().toLowerCase() !== 'jace48') return res.status(403).json({ ok: false });
  const now = Date.now();
  const nextState = enabled
    ? { status: 'scheduled', startAt: now + 5 * 60 * 1000, endedAt: 0 }
    : { status: 'ended', startAt: 0, endedAt: now };
  await dbSaveAccount('__sys_maintenance__', { name: 'SYSTEM_MAINTENANCE', pw: '', state: nextState });
  res.json({ ok: true, ...nextState });
});

app.post('/api/report-error', async (req, res) => {
  const { userId = 'guest', source = '', detail = '', time = '' } = req.body || {};
  if (String(userId).trim().toLowerCase() === 'jace48') return res.json({ ok: true });
  const rec = await dbGetAccount('__sys_errors__');
  const errors = (rec && rec.state && Array.isArray(rec.state.errors)) ? rec.state.errors : [];
  errors.unshift({ userId, source, detail: String(detail || '').slice(0, 400), time: time || new Date().toISOString() });
  if (errors.length > 60) errors.length = 60;
  await dbSaveAccount('__sys_errors__', { name: 'SYSTEM_ERRORS', pw: '', state: { errors } });
  res.json({ ok: true });
});

app.get('/api/admin/accounts', async (req, res) => {
  const userId = String(req.query.userId || '').trim().toLowerCase();
  if (userId !== 'jace48') return res.status(403).json({ ok: false });
  const rows = await dbListAllRows();
  const now = Date.now();
  const accounts = rows
    .filter(r => !String(r.user_id || '').startsWith('__sys_') && String(r.user_id || '').toLowerCase() !== 'jace48')
    .map(r => {
      const lastSeen = ONLINE_HEARTBEATS[r.user_id] || 0;
      const isOnline = (now - lastSeen) < 120000;
      const studentCount = (r.state && Array.isArray(r.state.students)) ? r.state.students.length : 0;
      return { userId: r.user_id, name: r.name || r.user_id, isOnline, studentCount };
    });
  res.json({ ok: true, accounts });
});

app.delete('/api/admin/accounts/:targetId', async (req, res) => {
  const userId = String(req.query.userId || (req.body && req.body.userId) || '').trim().toLowerCase();
  if (userId !== 'jace48') return res.status(403).json({ ok: false });
  await dbDeleteAccount(req.params.targetId);
  res.json({ ok: true });
});

app.get('/api/admin/errors', async (req, res) => {
  const userId = String(req.query.userId || '').trim().toLowerCase();
  if (userId !== 'jace48') return res.status(403).json({ ok: false });
  const rec = await dbGetAccount('__sys_errors__');
  const errors = (rec && rec.state && Array.isArray(rec.state.errors)) ? rec.state.errors : [];
  res.json({ ok: true, errors });
});


// 8. 건의사항 접수 (Gemini API 장난/무의미 판별) & jace48 열람
app.post('/api/suggestions', async (req, res) => {
  const { userId = 'guest', category = '건의', content = '' } = req.body || {};
  const text = String(content || '').trim();
  if (text.length < 5) {
    return res.json({ ok: false, rejected: true, reason: '건의 내용을 5자 이상 구체적으로 작성해 주세요.' });
  }
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (apiKey) {
    try {
      const checkPrompt = `당신은 교육 서비스 건의사항 검수 관리자입니다.
아래 사용자 건의가 실제 서비스 개선·오류 제보·기출 수정 요청·제휴 문의에 해당하는지, 아니면 장난·비속어·도배·무의미한 글자 나열인지 판별해 JSON만 반환하세요.
키: valid(boolean), reason(거절 시 사용자에게 띄울 정중한 경고 한 문장, 승인 시 빈 문자열).
카테고리: ${category}
내용: ${text}`;
      const aiRes = await callGeminiWithFallback(apiKey, {
        contents: [{ parts: [{ text: checkPrompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      }, 'chat');
      if (aiRes && aiRes.text) {
        const parsed = JSON.parse(aiRes.text);
        if (parsed && parsed.valid === false) {
          return res.json({
            ok: false,
            rejected: true,
            reason: parsed.reason || '장난스럽거나 무의미한 건의는 접수할 수 없습니다. 구체적인 내용을 다시 작성해 주세요.'
          });
        }
      }
    } catch (e) {}
  }

  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  const ts = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
  const rec = await dbGetAccount('__sys_suggestions__');
  const suggestions = (rec && rec.state && Array.isArray(rec.state.suggestions)) ? rec.state.suggestions : [];
  suggestions.unshift({ id: 's-' + Date.now(), userId, category, content: text.slice(0, 1000), createdAt: ts });
  if (suggestions.length > 100) suggestions.length = 100;
  await dbSaveAccount('__sys_suggestions__', { name: 'SYSTEM_SUGGESTIONS', pw: '', state: { suggestions } });
  res.json({ ok: true });
});

app.get('/api/admin/suggestions', async (req, res) => {
  const userId = String(req.query.userId || '').trim().toLowerCase();
  if (userId !== 'jace48') return res.status(403).json({ ok: false });
  const rec = await dbGetAccount('__sys_suggestions__');
  const suggestions = (rec && rec.state && Array.isArray(rec.state.suggestions)) ? rec.state.suggestions : [];
  res.json({ ok: true, suggestions });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`학생관리 서버 실행 중: http://0.0.0.0:${PORT}`);
});
