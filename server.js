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
const zlib = require('zlib');
// 응답 gzip 압축 미들웨어 (페이지 로딩 속도 및 Core Web Vitals 최적화)
app.use((req, res, next) => {
  const accept = String(req.headers['accept-encoding'] || '');
  if (!accept.includes('gzip') || req.path === '/api/pdf-proxy') return next();
  const origSend = res.send.bind(res);
  res.send = (body) => {
    try {
      const ct = String(res.getHeader('Content-Type') || '');
      if (typeof body === 'string' && body.length > 1024 && /html|json|xml|javascript|text|svg/i.test(ct || 'text/html')) {
        const gz = zlib.gzipSync(Buffer.from(body, 'utf8'));
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        return res.end(gz);
      }
    } catch (e) {}
    return origSend(body);
  };
  next();
});
const CLIENT_BUILD_VERSION = '20261128_v73';
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Surrogate-Control', 'no-store');
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
  await recordUserSeen(userId, true);
  res.json({ ok: true, loginAt: Date.now() });
});

app.post('/api/login', async (req, res) => {
  const { userId, pw } = req.body || {};
  const acc = await dbGetAccount(userId);
  if (!acc) return res.status(404).json({ error: '등록되지 않은 아이디입니다.' });
  if (acc.pw && acc.pw !== pw) return res.status(401).json({ error: '비밀번호가 일치하지 않습니다.' });
  await recordUserSeen(userId, true);
  res.json({ ok: true, name: acc.name, state: acc.state, loginAt: Date.now() });
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

app.post('/api/logout', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const userId = String((req.body && req.body.userId) || '').trim();
  if (!userId) return res.json({ ok: true });
  const now = Date.now();
  try {
    const rec = await dbGetAccount('__sys_logout_epochs__');
    const map = (rec && rec.state && typeof rec.state === 'object') ? { ...rec.state } : {};
    map[userId] = now;
    await dbSaveAccount('__sys_logout_epochs__', { name: 'SYSTEM_LOGOUT_EPOCHS', pw: '', state: map });
  } catch (e) {}
  res.json({ ok: true, logoutAt: now });
});

app.get('/api/state/:userId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { userId } = req.params;
  const loginAt = Number(req.query.loginAt || 0);
  const acc = await dbGetAccount(userId);
  if (!acc) return res.status(404).json({ ok: false });
  recordUserSeen(userId, false).catch(() => {});
  let forceLogout = false;
  try {
    const loRec = await dbGetAccount('__sys_logout_epochs__');
    const loAt = Number((loRec && loRec.state && loRec.state[userId]) || 0);
    forceLogout = false;
  } catch (e) {}
  res.json({ ok: true, name: acc.name, state: acc.state || {}, forceLogout });
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

app.use((req, res, next) => {
  if (req.path === '/') {
    res.setHeader('Link', '<https://student-manager-0rsy.onrender.com/>; rel="canonical"');
  }
  next();
});

app.get('/llms.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(`# 과외 학생 관리 (학생관리) · 대입 인문논술 기출 보고서
> 주요 12개 대학(연세대학교, 고려대학교, 서강대학교, 성균관대학교, 한양대학교, 중앙대학교, 경희대학교, 한국외국어대학교, 건국대학교, 동국대학교, 홍익대학교, 숙명여자대학교)의 인문논술 출제 경향과 2026학년도 선행학습 영향평가 보고서 무료 열람 및 과외 학생 통합 관리 플랫폼

## 공개 기능 (로그인 없이 이용 가능)
- 2026학년도 주요 12개 대학 선행학습 영향평가 보고서 PDF 미리보기 및 다운로드: https://student-manager-0rsy.onrender.com/
- 대학별 출제 경향 및 대비 포인트: 연세대, 고려대, 서강대, 성균관대, 한양대, 중앙대, 경희대, 한국외대, 건국대, 동국대, 홍익대, 숙명여대

## 선생님 전용 기능 (로그인 후 이용 가능)
- 2021~2026학년도 전체 논술 기출 및 선행학습 영향평가 보고서 열람
- 과외 학생별 논술 글 첨삭·약점 분석(제시문·해설 스크린샷 요약 반영)
- 회차별 누적 글 데이터, 진도·출결 관리, 학부모 문자 자동 작성
`);
});

const INDEXNOW_KEY = 'a9c4e7b2d8f14039b6e2a1d4f8c3e790';
app.get(`/${INDEXNOW_KEY}.txt`, (req, res) => {
  res.type('text/plain').send(INDEXNOW_KEY);
});

app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://student-manager-0rsy.onrender.com/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const today = new Date().toISOString().slice(0, 10);
  const univSlugs = ['yonsei','korea','sogang','skku','hanyang','cau','khu','hufs','konkuk','dongguk','hongik','sookmyung'];
  const korYears = [2027,2026,2025,2024,2023,2022,2021,2020,2019,2018,2017];
  const korTypes = ['6','9','suneung'];
  const urls = [
    { loc: `${baseUrl}/`, priority: '1.0', changefreq: 'daily' },
    ...univSlugs.map(u => ({ loc: `${baseUrl}/guide/${u}`, priority: '0.9', changefreq: 'weekly' })),
    ...korYears.flatMap(y => korTypes.map(t => ({ loc: `${baseUrl}/korean/${y}-${t}`, priority: y >= 2025 ? '0.9' : '0.8', changefreq: 'monthly' }))),
    ...univSlugs.map(u => ({ loc: `${baseUrl}/?univ=${u}`, priority: '0.7', changefreq: 'weekly' }))
  ];
  const xmlItems = urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xmlItems}\n</urlset>`);
});


// 2-1. Programmatic SEO 전용 공개 페이지 (/guide/:univId & /korean/:slug)
const SEO_UNIV_INFO = {
  yonsei: { name: '연세대학교', time: '120분', feature: '영어 제시문 · 통계 도표 분석', desc: '다면적 사고를 요구하는 3~4개 제시문 비교·해석 및 통계 자료 분석 출제. 영어 제시문 독해력과 논리적 추론이 핵심입니다.' },
  korea: { name: '고려대학교', time: '100분', feature: '요약 · 비교 · 적용 · 비판', desc: '제시문 핵심 논지 압축 요약과 다각적 비교·평가, 구체적 사례 적용 능력 평가. 정확한 독해와 간결한 논증이 중요합니다.' },
  sogang: { name: '서강대학교', time: '100분', feature: '2문항 · 고밀도 개념 적용', desc: '2개 문항 각 800~1,000자 내외. 다양한 분야의 지문을 통합해 현실 사회 현상을 깊이 분석하는 능력을 평가합니다.' },
  skku: { name: '성균관대학교', time: '100분', feature: '분류 · 자료 해석 · 대안 제시', desc: '1번 분류·요약, 2번 도표·통계 해석, 3번 입장 선택 및 반론 해결 구조로 명확한 틀과 논거 전개가 핵심입니다.' },
  hanyang: { name: '한양대학교', time: '90분', feature: '단일 문항 · 1,200자 종합', desc: '1,200자 단일 문항 중심. 제시문 간 유기적 연결과 창의적·비판적 추론을 한 편의 완결된 글로 풀어내야 합니다.' },
  cau: { name: '중앙대학교', time: '120분', feature: '3문항 · 언어논술·경영경제', desc: '3개 문항 구성. 제시문 핵심어 중심의 논지 비교와 문학·사회 지문을 연결한 다각적 해석이 중요합니다.' },
  khu: { name: '경희대학교', time: '120분', feature: '2~3문항 · 요약 및 논술', desc: '인문·사회계열별 출제. 제시문 분류·요약 후 사회 문제에 대한 비판적 대안을 논리적으로 서술해야 합니다.' },
  hufs: { name: '한국외국어대학교', time: '90분', feature: '영어 제시문 포함 · 3문항', desc: '영어 제시문 독해와 한국어 제시문 간 논지 비교·대조 및 구체적 사례 적용이 핵심 평가 요소입니다.' },
  konkuk: { name: '건국대학교', time: '100분', feature: '도표·문학 통합 · 2문항', desc: '인문사회Ⅰ(문학+인문)과 Ⅱ(도표+사회)로 구분되며, 자료 해석과 문학 작품의 주제 연결이 중요합니다.' },
  dongguk: { name: '동국대학교', time: '90분', feature: '3문항 · 짧은 분량 정밀 답안', desc: '300~700자 내외 3문항. 분량이 짧은 만큼 불필요한 수식을 줄이고 핵심 키워드를 정확히 짚어야 합니다.' },
  hongik: { name: '홍익대학교(서울)', time: '120분', feature: '2문항 · 각 800자 내외', desc: '사회·예술·인문 지문을 바탕으로 핵심 개념을 대비하고 현실 문제에 적용하는 논증 능력을 평가합니다.' },
  sookmyung: { name: '숙명여자대학교', time: '100분', feature: '2문항 · 제시문 비교 및 비판', desc: '제시문 간 공통점·차이점을 구조화해 정리하고 자신의 입장을 타당한 근거로 논증하는 데 초점을 둡니다.' }
};

function renderSeoSubPage({ title, description, canonicalUrl, badge, h1, bodyHtml, relatedLinks }) {
  const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large" />
  <link rel="canonical" href="${esc(canonicalUrl)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(canonicalUrl)}" />
  <meta property="og:site_name" content="과외 학생 관리 · 학생관리" />
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2857484634759539" crossorigin="anonymous"></script>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-800 antialiased min-h-screen flex flex-col">
  <header class="bg-white border-b border-slate-200 sticky top-0 z-20">
    <div class="max-w-4xl mx-auto px-4 py-3.5 flex items-center justify-between gap-3">
      <a href="/" class="text-sm sm:text-base font-extrabold text-slate-900">과외 학생 관리 · 학생관리</a>
      <a href="/" class="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold">기출 PDF · AI 해설 바로가기</a>
    </div>
  </header>
  <main class="flex-1 max-w-4xl w-full mx-auto px-4 py-8 space-y-6">
    <article class="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-sm space-y-5">
      <span class="inline-flex items-center px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 text-xs font-bold">${esc(badge)}</span>
      <h1 class="text-2xl sm:text-3xl font-extrabold text-slate-900 leading-snug">${esc(h1)}</h1>
      <div class="text-sm sm:text-base text-slate-700 leading-relaxed space-y-4">${bodyHtml}</div>
    </article>
    <section class="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm space-y-3">
      <h2 class="text-sm sm:text-base font-bold text-slate-900">관련 기출 · 가이드 바로가기</h2>
      <div class="flex flex-wrap gap-2">${relatedLinks}</div>
    </section>
  </main>
  <footer class="bg-slate-900 text-slate-400 text-xs py-6 text-center">
    <a href="/" class="text-slate-200 font-bold hover:underline">과외 학생 관리 홈으로 돌아가기</a>
  </footer>
</body>
</html>`;
}

app.get('/guide/:univId', (req, res) => {
  const uid = String(req.params.univId || '').toLowerCase();
  const u = SEO_UNIV_INFO[uid];
  if (!u) return res.redirect(302, '/');
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const related = Object.entries(SEO_UNIV_INFO)
    .filter(([k]) => k !== uid)
    .map(([k, v]) => `<a href="/guide/${k}" class="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-indigo-50 text-xs font-semibold text-slate-700">${v.name} 2026 논술</a>`)
    .join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderSeoSubPage({
    title: `${u.name} 2026 인문논술 출제 경향 · 기출 보고서 | 과외 학생 관리`,
    description: `${u.name} 2026 인문논술 출제 경향(${u.time}) 및 기출 보고서 PDF 무료 열람.`,
    canonicalUrl: `${baseUrl}/guide/${uid}`,
    badge: `2026 인문논술 가이드 · ${u.time}`,
    h1: `${u.name} 인문논술 출제 경향 및 2026 기출 보고서`,
    bodyHtml: `
      <p><strong>시험 시간 및 핵심 유형:</strong> ${u.time} · ${u.feature}</p>
      <p>${u.desc}</p>
      <div class="rounded-xl bg-indigo-50 border border-indigo-200 p-4 space-y-2">
        <div class="font-bold text-indigo-900">2026학년도 선행학습 영향평가 보고서 PDF 미리보기</div>
        <p class="text-xs text-indigo-800">메인 화면에서 로그인 없이 ${u.name} 2026 기출 보고서 PDF 전체 페이지를 바로 열람할 수 있으며, 선생님 로그인 시 2021~2026 전체 연도 조회와 학생 첨삭 관리가 가능합니다.</p>
        <a href="/?univ=${uid}#pubSearch" class="inline-block mt-1 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold">${u.name} 2026 보고서 바로 열기</a>
      </div>`,
    relatedLinks: related
  }));
});

app.get('/korean/:slug', (req, res) => {
  const m = String(req.params.slug || '').match(/^(201[7-9]|202[0-7])-(6|9|suneung)$/);
  if (!m) return res.redirect(302, '/');
  const year = m[1];
  const typeSlug = m[2];
  const type = typeSlug === 'suneung' ? '수능' : `${typeSlug}월`;
  const typeName = typeSlug === 'suneung' ? '대학수학능력시험(수능)' : `${typeSlug}월 모의평가(학력평가)`;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const isElective = Number(year) >= 2022;
  const preset = (typeof KOREAN_EXAM_PRESETS !== 'undefined' && KOREAN_EXAM_PRESETS[`${year}_${type}`]) || {};
  const related = [2027, 2026, 2025, 2024, 2023].flatMap(y => [
    `<a href="/korean/${y}-suneung" class="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-emerald-50 text-xs font-semibold text-slate-700">${y}학년도 수능 국어</a>`,
    `<a href="/korean/${y}-9" class="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-emerald-50 text-xs font-semibold text-slate-700">${y}학년도 9월 모평</a>`,
    `<a href="/korean/${y}-6" class="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-emerald-50 text-xs font-semibold text-slate-700">${y}학년도 6월 모평</a>`
  ]).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderSeoSubPage({
    title: `${year}학년도 ${typeName} 국어 기출 문제 · 정답표 · AI 해설 | 과외 학생 관리`,
    description: `${year}학년도 ${type} 국어 기출 문제 PDF, 정답표 및 AI 지문·선지 해설 제공.`,
    canonicalUrl: `${baseUrl}/korean/${year}-${typeSlug}`,
    badge: `국어 영역 기출 · ${year}학년도 ${type}`,
    h1: `${year}학년도 ${typeName} 국어 기출 문제 및 정답·해설`,
    bodyHtml: `
      <p><strong>시험 구성:</strong> ${isElective ? '공통과목(독서·문학 1~34번, 76점) + 선택과목(화법과 작문 / 언어와 매체 35~45번, 24점)' : '통합형 국어 영역 1~45번 (화법·작문·문법·독서·문학, 100점)'}</p>
      <p>과외 학생 관리 서비스의 <strong>국어 기출</strong> 탭에서 ${year}학년도 ${typeName} 문제지 PDF 전체 페이지를 바로 미리보기하고, ${isElective ? '공통·화작·언매 분리 정답표' : '1~45번 정답표'}와 Gemini AI 문항·지문 해설 대화 기능을 함께 활용할 수 있습니다.</p>
      <div class="flex flex-wrap gap-2 pt-1">
        ${preset.questionPdfUrl ? `<a href="${preset.questionPdfUrl}" target="_blank" rel="noopener" class="px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold">문제지 PDF 열기</a>` : ''}
        ${preset.answerPdfUrl ? `<a href="${preset.answerPdfUrl}" target="_blank" rel="noopener" class="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold">공식 정답·해설 PDF 열기</a>` : ''}
        <a href="/" class="px-4 py-2 rounded-xl border border-slate-300 bg-white text-slate-700 text-xs font-bold">웹앱에서 AI 해설 · 성적 관리 시작하기</a>
      </div>`,
    relatedLinks: related
  }));
});

app.get('/ads.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send('google.com, pub-2857484634759539, DIRECT, f08c47fec0942fa0\n');
});

app.get('/favicon.ico', (req, res) => { res.redirect(302, '/icon-192.png?v=6'); });

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
    id: '/?v=6',
    name: '학생관리 - 과외 관리',
    short_name: '학생관리',
    description: '과외 학생 글 첨삭 요약, 진도, 출결, 학부모 안내 통합 앱',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#6366f1',
    related_applications: [{ platform: 'webapp', url: 'https://student-manager-0rsy.onrender.com/manifest.json?v=6' }],
    icons: [
      { src: '/icon-192.png?v=6', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png?v=6', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon.svg?v=6', sizes: 'any', type: 'image/svg+xml' }
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

// 3-1. 국어 기출(2016~2026학년도 6월·9월·수능) 문제/정답 PDF 자동 탐색 API
const KOREAN_EXAM_PRESETS = {
  '2027_수능': {
    questionPdfUrl: 'https://cdn.kice.re.kr/27dae-suneung/27DaeSuneung_1.pdf',
    answerPdfUrl: 'https://cdn.kice.re.kr/27dae-suneung/27DaeSuneung_1a.pdf'
  },
  '2027_9월': {
    questionPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20260902/go3/kor_main_mun_23392788.pdf',
    answerPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20260902/go3/korA_1_hsj_TST9XSH4_1.pdf'
  },
  '2027_6월': {
    questionPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20260604/go3/kor_main_mun_95L2VLUY.pdf',
    answerPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20260604/go3/kor_main_hsj_2V29RZV3.pdf'
  },
  '2026_수능': {
    questionPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20251113/go3/live_main_paper_1_kor_352K8BKR.pdf',
    answerPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20251113/go3/live_main_answer_1_kor_8ZE3E1XR.pdf'
  },
  '2026_9월': {
    questionPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20250903/go3/kor_main_mun_O973Z9C5.pdf',
    answerPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20250903/go3/korA_1_hsj_K962J13R_3.pdf'
  },
  '2026_6월': {
    questionPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20250604/go3/kor_main_mun_G745R5NZ_1.pdf',
    answerPdfUrl: ''
  },
  '2025_수능': {
    questionPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20241114/go3/korB_1_mun_Y6RJMQA1_1.pdf',
    answerPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20241114/go3/live_main_answer_1_kor_2IWY95KX.pdf'
  },
  '2025_9월': {
    questionPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20240904/go3/kor_main_mun_86FDX88U_1.pdf',
    answerPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20240904/go3/kor_main_hsj_EFE33512_1.pdf'
  },
  '2025_6월': {
    questionPdfUrl: '',
    answerPdfUrl: 'https://wdown.ebsi.co.kr/W61001/01exam/20240604/go3/kor_main_hsj_2C42VZKT_2.pdf'
  },
  '2024_수능': {
    questionPdfUrl: '',
    answerPdfUrl: 'https://image.donga.com/education/exam/2024su/an1_1.pdf'
  },
  '2020_수능': {
    questionPdfUrl: 'https://image.donga.com/education/exam/2020_su/1_1.pdf',
    answerPdfUrl: 'https://image.donga.com/education/exam/2020_su/1_1.pdf'
  },
  '2019_수능': {
    questionPdfUrl: 'https://image.donga.com/education/exam/2019_su/1_1.pdf',
    answerPdfUrl: 'https://image.donga.com/education/exam/2019_su/1_1.pdf'
  },
  '2018_수능': {
    questionPdfUrl: 'https://image.donga.com/education/exam/2018_su/1_1.pdf',
    answerPdfUrl: 'https://image.donga.com/education/exam/2018_su/1_1.pdf'
  }
};

const HORAENG_POST_MAP = {
  '2027_수능': '469',
  '2026_수능': '446',
  '2025_수능': '420',
  '2024_수능': '350',
  '2024_9월': '267',
  '2024_6월': '263',
  '2023_수능': '254',
  '2023_9월': '252'
};

const LEGENDSTUDY_POST_MAP = {
  '2027_9월': '1710',
  '2025_9월': '1634',
  '2024_수능': '1574',
  '2024_9월': '1525',
  '2024_6월': '1516',
  '2023_9월': '1507'
};

async function searchHoraengKoreanPdf(year, type) {
  const key = `${year}_${type}`;
  let postUrl = HORAENG_POST_MAP[key] ? `https://horaeng.com/${HORAENG_POST_MAP[key]}` : '';
  if (!postUrl) {
    const q = `${year}학년도 ${type === '수능' ? '수능' : type + ' 모의평가'}`;
    const searchHtml = await fetchTextWithTimeout(`https://horaeng.com/?s=${encodeURIComponent(q)}`, 7000);
    if (searchHtml) {
      const m = searchHtml.match(/href=["'](https:\/\/horaeng\.com\/\d+)["']/i);
      if (m) postUrl = m[1];
    }
  }
  if (!postUrl) return { mun: '', hsj: '' };
  const html = await fetchTextWithTimeout(postUrl, 8000);
  if (!html) return { mun: '', hsj: '' };
  const allLinks = [...html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({
    url: m[1].replace(/&amp;/g, '&'),
    text: stripHtmlText(m[2])
  }));
  const korPdfs = allLinks.filter(l => /\.pdf(?:$|\?)/i.test(l.url) && (/국어/.test(l.text) || /국어|kor/i.test(decodeURIComponent(l.url))));
  let mun = (korPdfs.find(l => /문제|mun|paper/i.test(l.text + ' ' + decodeURIComponent(l.url))) || {}).url || '';
  let hsj = (korPdfs.find(l => /해설|정답|hsj|answer/i.test(l.text + ' ' + decodeURIComponent(l.url))) || {}).url || '';
  if (!mun || !hsj) {
    const korIdx = html.search(/국어\s*<\/(?:h[234]|span|strong)>/i);
    const slice = korIdx >= 0 ? html.slice(korIdx, korIdx + 4500) : html.slice(0, 8000);
    const pdfs = [...slice.matchAll(/href=["'](https?:\/\/[^"']+\.pdf[^"']*)["']/gi)].map(m => m[1].replace(/&amp;/g, '&'));
    if (!mun) mun = pdfs.find(u => /문제|mun|paper/i.test(decodeURIComponent(u))) || pdfs[0] || '';
    if (!hsj) hsj = pdfs.find(u => /해설|정답|hsj|answer/i.test(decodeURIComponent(u))) || pdfs[1] || '';
  }
  return { mun, hsj };
}

async function searchLegendstudyKoreanPdf(year, type) {
  const key = `${year}_${type}`;
  const pid = LEGENDSTUDY_POST_MAP[key];
  if (!pid) return { mun: '', hsj: '' };
  const html = await fetchTextWithTimeout(`https://legendstudy.com/${pid}`, 8000);
  if (!html) return { mun: '', hsj: '' };
  const links = [...html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({
    url: m[1].replace(/&amp;/g, '&'),
    text: stripHtmlText(m[2])
  }));
  const korLinks = links.filter(l => /국어/.test(l.text) && (/\.pdf/i.test(l.url) || /daumcdn|kakaocdn|tistory\.com\/attachment/i.test(l.url)));
  const mun = (korLinks.find(l => /문제/.test(l.text)) || {}).url || '';
  const hsj = (korLinks.find(l => /정답|해설/.test(l.text)) || {}).url || '';
  return { mun, hsj };
}

async function checkUrlExists(url) {
  if (!url) return false;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3500);
    const r = await fetch(url, { method: 'HEAD', signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    if (r.ok) return true;
  } catch (e) {}
  try {
    const c2 = new AbortController();
    const t2 = setTimeout(() => c2.abort(), 4000);
    const r2 = await fetch(url, { method: 'GET', signal: c2.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-31' } });
    clearTimeout(t2);
    return r2.ok || r2.status === 206;
  } catch (e2) {
    return false;
  }
}

async function searchEbsiKoreanPdf(year, type, kind) {
  const examLabel = type === '수능' ? '대학수학능력시험' : (type === '9월' ? '9월 모의평가' : '6월 모의평가');
  const execYear = Number(year) - 1;
  const mm = type === '수능' ? '11' : (type === '9월' ? '09' : '06');
  const prefix = `${execYear}${mm}`;
  const q1 = kind === 'mun'
    ? `site:wdown.ebsi.co.kr "${year}학년도" "${examLabel}" 국어 문제`
    : `site:wdown.ebsi.co.kr "${year}학년도" "${examLabel}" 국어 정답`;
  const q2 = kind === 'mun'
    ? `"wdown.ebsi.co.kr" "${prefix}" 국어 문제 pdf`
    : `"wdown.ebsi.co.kr" "${prefix}" 국어 정답 해설 pdf`;
  const urlsToTry = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q1)}`,
    `https://search.naver.com/search.naver?where=nexearch&query=${encodeURIComponent(q2)}`,
    `https://search.daum.net/search?w=tot&q=${encodeURIComponent(q2)}`
  ];
  const pages = await Promise.all(urlsToTry.map(u => fetchTextWithTimeout(u, 4500)));
  const combined = pages.join(' ');
  const matches = [...combined.matchAll(/https?:\/\/(?:wdown\.ebsi\.co\.kr|cdn\.kice\.re\.kr|cdn\.teamturing\.com)\/[^"'\s<>\\]+\.pdf/gi)]
    .map(m => m[0].replace(/&amp;/g, '&'));
  const filtered = matches.filter(u => {
    const low = u.toLowerCase();
    if (low.includes('teamturing.com')) {
      return low.includes(`/03/${execYear}/03-${mm}`) && (kind === 'mun' ? low.includes('-p-') : (low.includes('-s-') || low.includes('-a-')));
    }
    return (low.includes('kor') || low.includes('suneung')) && (kind === 'mun' ? (low.includes('mun') || low.includes('paper') || low.includes('suneung_1.pdf')) : (low.includes('hsj') || low.includes('answer') || low.includes('suneung_1a.pdf')));
  });
  const exact = filtered.find(u => u.includes(prefix) || u.includes(`${execYear}/03-${mm}`));
  return exact || filtered[0] || '';
}


const GRADE_CUTS_CACHE = {};
const KOREAN_EXAM_URL_CACHE = {};
const VERIFIED_GRADE_CUTS = {
  '2027_수능': {
    ebsi: { g1: '화작94/언매90', g2: '화작89/언매85', g3: '화작81/언매77' },
    megastudy: { g1: '화작94~95/언매90~91', g2: '화작88~90/언매84~86', g3: '화작80~83/언매76~79' },
    mimac: { g1: '화작95/언매91', g2: '화작89/언매85', g3: '화작81/언매77' },
    jongro: { g1: '화작95/언매91', g2: '화작89/언매84', g3: '화작81/언매77' },
    etoos: { g1: '화작94~95/언매90~91', g2: '화작88/언매84', g3: '화작80~81/언매76~77' }
  },
  '2027_9월': { single: { g1: '화작90/언매86', g2: '화작82/언매79', g3: '화작75/언매71' } },
  '2027_6월': { single: { g1: '화작95/언매95', g2: '화작90/언매90', g3: '화작82/언매82' } },
  '2026_수능': { single: { g1: '화작90/언매85', g2: '화작82/언매78', g3: '화작73/언매69' } },
  '2026_9월': { single: { g1: '화작92/언매86', g2: '화작86/언매81', g3: '화작78/언매73' } },
  '2026_6월': { single: { g1: '화작97/언매92', g2: '화작90/언매85', g3: '화작81/언매77' } },
  '2025_수능': { single: { g1: '화작94/언매91', g2: '화작88/언매85', g3: '화작79/언매76' } },
  '2025_9월': { single: { g1: '화작100/언매97', g2: '화작96/언매93', g3: '화작88/언매86' } },
  '2025_6월': { single: { g1: '화작85/언매83', g2: '화작78/언매76', g3: '화작70/언매68' } },
  '2024_수능': { single: { g1: '화작87/언매84', g2: '화작79/언매76', g3: '화작71/언매68' } },
  '2024_9월': { single: { g1: '화작90/언매86', g2: '화작82/언매79', g3: '화작75/언매72' } },
  '2024_6월': { single: { g1: '화작97/언매93', g2: '화작90/언매86', g3: '화작82/언매77' } },
  '2023_수능': { single: { g1: '화작96/언매91', g2: '화작91/언매87', g3: '화작86/언매82' } },
  '2023_9월': { single: { g1: '화작92/언매87', g2: '화작85/언매81', g3: '화작78/언매75' } },
  '2023_6월': { single: { g1: '화작85/언매82', g2: '화작78/언매75', g3: '화작70/언매67' } },
  '2022_수능': { single: { g1: '화작84/언매83', g2: '화작78/언매77', g3: '화작71/언매70' } },
  '2022_9월': { single: { g1: '화작100/언매96', g2: '화작96/언매93', g3: '화작90/언매86' } },
  '2022_6월': { single: { g1: '화작90/언매85', g2: '화작81/언매78', g3: '화작73/언매69' } },
  '2021_수능': { single: { g1: '88', g2: '82', g3: '74' } },
  '2021_9월': { single: { g1: '90', g2: '84', g3: '77' } },
  '2021_6월': { single: { g1: '92', g2: '85', g3: '75' } },
  '2020_수능': { single: { g1: '91', g2: '85', g3: '77' } },
  '2020_9월': { single: { g1: '90', g2: '83', g3: '76' } },
  '2020_6월': { single: { g1: '87', g2: '80', g3: '72' } },
  '2019_수능': { single: { g1: '84', g2: '78', g3: '70' } },
  '2019_9월': { single: { g1: '97', g2: '92', g3: '85' } },
  '2019_6월': { single: { g1: '91', g2: '84', g3: '75' } },
  '2018_수능': { single: { g1: '94', g2: '89', g3: '82' } },
  '2018_9월': { single: { g1: '93', g2: '88', g3: '81' } },
  '2018_6월': { single: { g1: '89', g2: '80', g3: '72' } },
  '2017_수능': { single: { g1: '92', g2: '86', g3: '79' } },
  '2017_9월': { single: { g1: '90', g2: '83', g3: '75' } },
  '2017_6월': { single: { g1: '90', g2: '83', g3: '75' } }
};

function stripHtmlText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchTextWithTimeout(url, timeoutMs = 4500) {
  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8'
      }
    });
    clearTimeout(tm);
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const headLatin = buf.slice(0, 1200).toString('latin1').toLowerCase();
    const isEucKr = ct.includes('euc-kr') || ct.includes('ks_c_5601') || headLatin.includes('euc-kr') || headLatin.includes('ks_c_5601');
    if (isEucKr) {
      try { return new TextDecoder('euc-kr').decode(buf); } catch (e) {}
    }
    return buf.toString('utf8');
  } catch (e) {
    return '';
  }
}

async function fetchGoogleNewsRssWithArticles(query) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
  const xml = await fetchTextWithTimeout(rssUrl, 5000);
  if (!xml) return '';
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 5);
  let out = items.map(m => stripHtmlText(m[1])).join('\n');
  const links = items
    .map(m => {
      const lm = m[1].match(/<link>(https?:\/\/[^<]+)<\/link>/i);
      return lm ? lm[1].trim() : '';
    })
    .filter(u => u && !u.endsWith('.pdf'))
    .slice(0, 3);
  if (links.length) {
    const pages = await Promise.all(links.map(u => fetchTextWithTimeout(u, 4000)));
    out += '\n' + pages.map(p => stripHtmlText(p).slice(0, 5000)).filter(Boolean).join('\n');
  }
  return out;
}

async function fetchDaumSearchWithArticles(query) {
  const daumUrl = `https://search.daum.net/search?w=tot&q=${encodeURIComponent(query)}`;
  const html = await fetchTextWithTimeout(daumUrl, 5000);
  if (!html) return '';
  let out = stripHtmlText(html).slice(0, 7500);
  const urls = [...html.matchAll(/href="(https?:\/\/(?!search\.daum\.net|t1\.daumcdn\.net|cs\.daum\.net)[^"]+)"/gi)]
    .map(m => m[1].replace(/&amp;/g, '&'))
    .filter(u => !u.endsWith('.pdf') && !u.includes('kakao.com') && (u.includes('news') || u.includes('article') || u.includes('ebsi') || u.includes('megastudy') || u.includes('jongro') || u.includes('etoos') || u.includes('mimac') || u.includes('sanedu') || u.includes('veritas') || u.includes('chosun') || u.includes('yna') || u.includes('newsis') || u.includes('hankyung') || u.includes('mk.co.kr')))
    .slice(0, 3);
  if (urls.length) {
    const pages = await Promise.all(urls.map(u => fetchTextWithTimeout(u, 4000)));
    out += '\n' + pages.map(p => stripHtmlText(p).slice(0, 5000)).filter(Boolean).join('\n');
  }
  return out;
}

async function fetchDdgWithArticles(query) {
  const html = await fetchTextWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 5000);
  if (!html) return '';
  let combined = stripHtmlText(html).slice(0, 5500) + '\n';
  const urls = [...html.matchAll(/uddg=(https?%3A%2F%2F[^"&]+)/gi)]
    .map(m => decodeURIComponent(m[1]))
    .filter(u => !u.includes('duckduckgo.com') && !u.endsWith('.pdf'))
    .slice(0, 2);
  if (urls.length) {
    const pages = await Promise.all(urls.map(u => fetchTextWithTimeout(u, 4000)));
    combined += pages.map(p => stripHtmlText(p).slice(0, 5500)).filter(Boolean).join('\n');
  }
  return combined;
}

const EBSI_IRECORD_MAP = {
  '2027_수능': '202611193',
  '2027_9월': '202609023',
  '2027_6월': '202606043',
  '2026_수능': '202511133',
  '2026_9월': '202509033',
  '2026_6월': '202506043',
  '2025_수능': '202411143',
  '2025_9월': '202409043',
  '2025_6월': '202406043',
  '2024_수능': '202311163',
  '2024_9월': '202309063',
  '2024_6월': '202306013',
  '2023_수능': '202211173',
  '2023_9월': '202209013',
  '2023_6월': '202206093'
};

async function fetchNaverSearchWithArticles(query) {
  const naverUrl = `https://search.naver.com/search.naver?where=nexearch&query=${encodeURIComponent(query)}`;
  const html = await fetchTextWithTimeout(naverUrl, 5000);
  if (!html) return '';
  let out = stripHtmlText(html).slice(0, 7500);
  const urls = [...html.matchAll(/href="(https?:\/\/(?!search\.naver\.com|nid\.naver\.com|static\.naver\.net)[^"]+)"/gi)]
    .map(m => m[1].replace(/&amp;/g, '&'))
    .filter(u => !u.endsWith('.pdf') && (u.includes('news') || u.includes('article') || u.includes('veritas') || u.includes('ebsi') || u.includes('megastudy') || u.includes('jongro') || u.includes('etoos') || u.includes('mimac') || u.includes('jinhak') || u.includes('newsis') || u.includes('yna') || u.includes('chosun') || u.includes('hankyung') || u.includes('mk.co.kr') || u.includes('edaily')))
    .slice(0, 3);
  if (urls.length) {
    const pages = await Promise.all(urls.map(u => fetchTextWithTimeout(u, 4000)));
    out += '\n' + pages.map(p => stripHtmlText(p).slice(0, 5000)).filter(Boolean).join('\n');
  }
  return out;
}

async function fetchDirectInstitutePages(key) {
  const irecord = EBSI_IRECORD_MAP[key];
  if (!irecord) return '';
  const yyyymmdd = irecord.slice(0, 8);
  const yymmdd = irecord.slice(2, 8);
  const urls = [
    { name: 'EBSi', url: `https://www.ebsi.co.kr/ebs/xip/xipa/retrieveSCVMainInfo.ebs?irecord=${irecord}&targetCd=D300` },
    { name: '종로학원', url: `https://b.jongro.co.kr/exam/ex${yymmdd}/go3_cut.asp` },
    { name: '종로학원확정', url: `https://www.jongro.co.kr/service/examResult/ex${yyyymmdd}/go3_resultCut.asp` },
    { name: '이투스', url: `https://m.etoos.com/exam/quiz/${yyyymmdd}_3/grade.asp` },
    { name: '대성마이맥', url: `https://www.mimacstudy.com/entexm/info/entexmMain.ds?requestMenuId=MNMN_M008` }
  ];
  const results = await Promise.all(urls.map(async (u) => {
    const html = await fetchTextWithTimeout(u.url, 5000);
    if (!html) return '';
    const txt = stripHtmlText(html);
    if (!txt || txt.length < 60) return '';
    // Focus on Korean section if long
    const kIdx = txt.indexOf('국어');
    const slice = kIdx >= 0 ? txt.slice(Math.max(0, kIdx - 80), kIdx + 2600) : txt.slice(0, 2600);
    return `[${u.name} 공식 사이트 직접 수집] ${slice}`;
  }));
  return results.filter(Boolean).join('\n');
}

app.get('/api/korean-grade-cuts', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const year = String(req.query.year || '2027').replace(/[^0-9]/g, '');
  const type = String(req.query.type || '수능').trim();
  const yNum = Number(year);
  if (!yNum || yNum < 2023 || yNum > 2027) {
    return res.json({ ok: false, year, type, error: '기관별 원점수 등급컷은 2023~2027학년도만 지원됩니다.', cuts: null });
  }
  const key = `${year}_${type}`;
  const isMock = !(year === '2027' && type === '수능');
  if (GRADE_CUTS_CACHE[key]) {
    return res.json(Object.assign({ ok: true, year, type, isMock, cached: true }, GRADE_CUTS_CACHE[key]));
  }

  const preset = VERIFIED_GRADE_CUTS[key] || {};
  const baseCuts = {
    ebsi: Object.assign({ g1: '-', g2: '-', g3: '-' }, preset.ebsi || {}),
    megastudy: Object.assign({ g1: '-', g2: '-', g3: '-' }, preset.megastudy || {}),
    mimac: Object.assign({ g1: '-', g2: '-', g3: '-' }, preset.mimac || {}),
    jongro: Object.assign({ g1: '-', g2: '-', g3: '-' }, preset.jongro || {}),
    etoos: Object.assign({ g1: '-', g2: '-', g3: '-' }, preset.etoos || {})
  };
  const singleCut = Object.assign({ g1: '-', g2: '-', g3: '-' }, preset.single || {});

  const needScrape = isMock
    ? (singleCut.g1 === '-' || singleCut.g2 === '-' || singleCut.g3 === '-')
    : Object.values(baseCuts).some(c => c.g1 === '-' || c.g2 === '-' || c.g3 === '-');

  if (needScrape) {
    const examLabel = type === '수능' ? '수능' : `${type} 모의평가`;
    const [dirTxt, naver1, daum1, gNews1] = await Promise.all([
      fetchDirectInstitutePages(key),
      fetchNaverSearchWithArticles(`${year}학년도 ${examLabel} 국어 원점수 등급컷 화작 언매 1등급 2등급 3등급`),
      fetchDaumSearchWithArticles(`${year}학년도 ${examLabel} 국어 원점수 등급컷 메가스터디 대성 종로 이투스 EBSi`),
      fetchGoogleNewsRssWithArticles(`${year}학년도 ${examLabel} 국어 원점수 등급컷 화작 언매`)
    ]);
    const snippets = [dirTxt, naver1, daum1, gNews1].filter(Boolean).join('\n').slice(0, 32000);
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (apiKey && snippets.length > 80) {
      const prompt = isMock
        ? `아래 텍스트에서 ${year}학년도 ${examLabel} 국어 영역의 **원점수** 대표 1등급·2등급·3등급 컷을 추출하세요.
[규칙] 100점 만점 원점수만(101점 이상 표준점수 제외). 화작/언매 구분 시 "화작89/언매84" 형태로 적고 없으면 "-".
JSON만 출력: {"g1":"-","g2":"-","g3":"-"}
[텍스트]
${snippets}`
        : `아래 텍스트에서 ${year}학년도 수능 국어 영역의 기관별(EBSi, 메가스터디, 대성마이맥, 종로학원, 이투스) **원점수** 1등급·2등급·3등급 컷을 추출하세요.
[규칙] 100점 만점 원점수만(101점 이상 표준점수 제외). 화작/언매 구분 시 "화작94/언매90" 형태. 본문에 없는 것은 "-".
JSON만 출력: {"ebsi":{"g1":"-","g2":"-","g3":"-"},"megastudy":{"g1":"-","g2":"-","g3":"-"},"mimac":{"g1":"-","g2":"-","g3":"-"},"jongro":{"g1":"-","g2":"-","g3":"-"},"etoos":{"g1":"-","g2":"-","g3":"-"}}
[텍스트]
${snippets}`;
      try {
        const gRes = await callGeminiWithFallback(
          apiKey,
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } } },
          'chat'
        );
        if (gRes && gRes.text) {
          const m = gRes.text.match(/\{[\s\S]*\}/);
          if (m) {
            const parsed = JSON.parse(m[0]);
            const validRaw = (v) => {
              const str = String(v || '-').trim();
              const nums = str.match(/\d+/g) || [];
              return str && str !== '-' && !nums.some(n => Number(n) > 100) ? str.slice(0, 22) : '';
            };
            if (isMock) {
              ['g1', 'g2', 'g3'].forEach(gk => {
                const okv = validRaw(parsed[gk]);
                if (okv && singleCut[gk] === '-') singleCut[gk] = okv;
              });
            } else {
              for (const k of ['ebsi', 'megastudy', 'mimac', 'jongro', 'etoos']) {
                if (parsed[k] && typeof parsed[k] === 'object') {
                  ['g1', 'g2', 'g3'].forEach(gk => {
                    const okv = validRaw(parsed[k][gk]);
                    if (okv && baseCuts[k][gk] === '-') baseCuts[k][gk] = okv;
                  });
                }
              }
            }
          }
        }
      } catch (e) {}
    }
  }

  const outObj = isMock ? { isMock: true, singleCut, cuts: baseCuts } : { isMock: false, cuts: baseCuts };
  if (isMock ? (singleCut.g1 !== '-') : (Object.values(baseCuts).filter(c => c.g1 !== '-').length >= 4)) {
    GRADE_CUTS_CACHE[key] = outObj;
  }
  res.json(Object.assign({ ok: true, year, type }, outObj));
});

app.get('/api/korean-exam', async (req, res) => {
  const year = String(req.query.year || '2026').replace(/[^0-9]/g, '');
  const type = String(req.query.type || '수능').trim();
  const yNum = Number(year);
  if (!yNum || yNum < 2017 || yNum > 2027) {
    return res.status(400).json({ ok: false, error: '학년도는 2017~2027 사이여야 합니다.' });
  }
  const cacheKey = `${year}_${type}`;
  if (KOREAN_EXAM_URL_CACHE[cacheKey]) {
    const cachedP = Object.assign({}, KOREAN_EXAM_URL_CACHE[cacheKey]);
    if (typeof KOREAN_PARSED_ANSWERS_CACHE !== 'undefined' && KOREAN_PARSED_ANSWERS_CACHE[cacheKey]) {
      const ca = KOREAN_PARSED_ANSWERS_CACHE[cacheKey];
      const okCache = yNum >= 2022
        ? (Object.keys(ca.commonMap || {}).length >= 34 && Object.keys(ca.hwajakMap || {}).length >= 11 && Object.keys(ca.eonmaeMap || {}).length >= 11)
        : (Object.keys(ca.commonMap || {}).length >= 45);
      if (okCache) cachedP.cachedAnswers = ca;
    }
    return res.json(cachedP);
  }
  const mm = type === '수능' ? '11' : (type === '9월' ? '09' : '06');
  const execYear = yNum - 1;
  const preset = KOREAN_EXAM_PRESETS[cacheKey] || {};

  let questionPdfUrl = preset.questionPdfUrl || '';
  let answerPdfUrl = preset.answerPdfUrl || '';

  const ttProbCands = [
    `https://cdn.teamturing.com/cms/webflow/sat_pdf/03/${execYear}/03-${mm}-01-p-01.pdf`,
    `https://cdn.teamturing.com/cms/webflow/sat_pdf/03/${execYear}/03-${mm}-01-p-02.pdf`
  ];
  const ttAnsCands = [
    `https://cdn.teamturing.com/cms/webflow/sat_pdf/03/${execYear}/03-${mm}-01-s-01.pdf`,
    `https://cdn.teamturing.com/cms/webflow/sat_pdf/03/${execYear}/03-${mm}-01-a-01.pdf`
  ];

  const [pChk0, pChk1, aChk0, aChk1] = await Promise.all([
    !questionPdfUrl ? checkUrlExists(ttProbCands[0]) : Promise.resolve(false),
    !questionPdfUrl ? checkUrlExists(ttProbCands[1]) : Promise.resolve(false),
    !answerPdfUrl ? checkUrlExists(ttAnsCands[0]) : Promise.resolve(false),
    !answerPdfUrl ? checkUrlExists(ttAnsCands[1]) : Promise.resolve(false)
  ]);
  if (!questionPdfUrl) questionPdfUrl = pChk0 ? ttProbCands[0] : (pChk1 ? ttProbCands[1] : '');
  if (!answerPdfUrl) answerPdfUrl = aChk0 ? ttAnsCands[0] : (aChk1 ? ttAnsCands[1] : '');

  if (!questionPdfUrl || !answerPdfUrl) {
    const [hr, ls, ebsiMun, ebsiHsj, dongaOk] = await Promise.all([
      searchHoraengKoreanPdf(year, type),
      searchLegendstudyKoreanPdf(year, type),
      !questionPdfUrl ? searchEbsiKoreanPdf(year, type, 'mun') : Promise.resolve(''),
      !answerPdfUrl ? searchEbsiKoreanPdf(year, type, 'hsj') : Promise.resolve(''),
      (!questionPdfUrl && type === '수능' && yNum <= 2020)
        ? checkUrlExists(`https://image.donga.com/education/exam/${year}_su/1_1.pdf`)
        : Promise.resolve(false)
    ]);
    if (!questionPdfUrl) questionPdfUrl = hr.mun || ls.mun || ebsiMun || (dongaOk ? `https://image.donga.com/education/exam/${year}_su/1_1.pdf` : '');
    if (!answerPdfUrl) answerPdfUrl = hr.hsj || ls.hsj || ebsiHsj || (dongaOk ? `https://image.donga.com/education/exam/${year}_su/1_1.pdf` : '');
  }

  let cachedAns = (typeof KOREAN_PARSED_ANSWERS_CACHE !== 'undefined' && KOREAN_PARSED_ANSWERS_CACHE[cacheKey]) || null;
  const isAnsComplete = (ca) => {
    if (!ca) return false;
    const cLen = Object.keys(ca.commonMap || {}).length;
    const hLen = Object.keys(ca.hwajakMap || {}).length;
    const eLen = Object.keys(ca.eonmaeMap || {}).length;
    return yNum >= 2022 ? (cLen >= 34 && hLen >= 11 && eLen >= 11) : (cLen >= 45);
  };
  if (!isAnsComplete(cachedAns)) {
    cachedAns = null;
    const targetPdfForAns = answerPdfUrl || questionPdfUrl;
    if (targetPdfForAns && typeof extractKoreanAnswersFromPdfOnServer === 'function') {
      const extracted = await extractKoreanAnswersFromPdfOnServer(yNum, type, targetPdfForAns);
      if (isAnsComplete(extracted)) cachedAns = extracted;
    }
  }

  const payload = {
    ok: true,
    year,
    type,
    questionPdfUrl,
    answerPdfUrl,
    cachedAnswers: cachedAns,
    ebsiUrl: 'https://www.ebsi.co.kr/ebs/xip/xipc/previousPaperList.ebs?targetCd=D300'
  };
  if (questionPdfUrl && answerPdfUrl) {
    KOREAN_EXAM_URL_CACHE[cacheKey] = payload;
  }
  res.json(payload);
});



const KOREAN_PARSED_ANSWERS_CACHE = (() => {
  try {
    const db = readDb();
    return (db && db.koreanParsedAnswers) ? db.koreanParsedAnswers : {};
  } catch (e) { return {}; }
})();
function saveParsedAnswersCache() {
  try {
    const db = readDb();
    db.koreanParsedAnswers = KOREAN_PARSED_ANSWERS_CACHE;
    writeDb(db);
  } catch (e) {}
}
async function extractKoreanAnswersFromPdfOnServer(yNum, type, pdfUrl) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const key = `${yNum}_${type}`;
  if (!apiKey || !pdfUrl) return null;
  if (KOREAN_PARSED_ANSWERS_CACHE[key]) {
    const c = KOREAN_PARSED_ANSWERS_CACHE[key];
    const ok = yNum >= 2022
      ? (Object.keys(c.commonMap || {}).length >= 34 && Object.keys(c.hwajakMap || {}).length >= 11 && Object.keys(c.eonmaeMap || {}).length >= 11)
      : (Object.keys(c.commonMap || {}).length >= 45);
    if (ok) return c;
  }
  try {
    const up = await fetchBinaryWithTlsBypass(pdfUrl);
    if (!up || up.status < 200 || up.status >= 400 || !up.buffer || up.buffer.length > 9 * 1024 * 1024) return null;
    const pdfB64 = up.buffer.toString('base64');
    const isElective = yNum >= 2022;
    const typeLabel = type === '수능' ? '대학수학능력시험(수능)' : `${type || ''} 모의평가`;
    const prompt = isElective
      ? `첨부된 ${yNum}학년도 ${typeLabel} 국어 영역 PDF에서 **홀수형 기준**으로 1~34번 공통과목, 35~45번 화법과 작문, 35~45번 언어와 매체 정답을 모두 추출해 원문자(①,②,③,④,⑤) JSON만 출력하세요. 없는 과목은 {}로 두세요.
{"common":{"1":"①"},"hwajak":{"35":"④"},"eonmae":{"35":"②"}}`
      : `첨부된 ${yNum}학년도 ${typeLabel} 국어 영역 PDF에서 **홀수형 기준** 1~45번 공식 정답을 모두 추출해 원문자(①,②,③,④,⑤) JSON만 출력하세요.
{"common":{"1":"①"}}`;
    const r = await callGeminiWithFallback(apiKey, {
      contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'application/pdf', data: pdfB64 } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json' }
    }, 'chat');
    if (r && r.text) {
      const m = r.text.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        const cMap = parsed.common || {};
        const hMap = parsed.hwajak || {};
        const eMap = parsed.eonmae || {};
        const ok = isElective
          ? (Object.keys(cMap).length >= 34 && Object.keys(hMap).length >= 11 && Object.keys(eMap).length >= 11)
          : (Object.keys(cMap).length >= 45);
        if (ok) {
          const out = { ok: true, commonMap: cMap, hwajakMap: hMap, eonmaeMap: eMap };
          KOREAN_PARSED_ANSWERS_CACHE[key] = out;
          saveParsedAnswersCache();
          return out;
        }
      }
    }
  } catch (e) {}
  return null;
}

app.post('/api/korean-cache-answers', (req, res) => {
  const { year, type, commonMap, hwajakMap, eonmaeMap } = req.body || {};
  const key = year && type ? `${year}_${type}` : '';
  const yN = Number(year || 2026);
  const cLen = commonMap ? Object.keys(commonMap).length : 0;
  const hLen = hwajakMap ? Object.keys(hwajakMap).length : 0;
  const eLen = eonmaeMap ? Object.keys(eonmaeMap).length : 0;
  const isComplete = yN >= 2022 ? (cLen >= 34 && hLen >= 11 && eLen >= 11) : (cLen >= 45);
  if (key && isComplete) {
    KOREAN_PARSED_ANSWERS_CACHE[key] = {
      ok: true,
      commonMap,
      hwajakMap: hwajakMap || {},
      eonmaeMap: eonmaeMap || {}
    };
    saveParsedAnswersCache();
  }
  res.json({ ok: true });
});

app.get('/api/korean-cached-answers', async (req, res) => {
  const year = String(req.query.year || '').trim();
  const type = String(req.query.type || '').trim();
  const key = year && type ? `${year}_${type}` : '';
  const yN = Number(year || 2026);
  const isOk = (ca) => {
    if (!ca) return false;
    const cLen = Object.keys(ca.commonMap || {}).length;
    const hLen = Object.keys(ca.hwajakMap || {}).length;
    const eLen = Object.keys(ca.eonmaeMap || {}).length;
    return yN >= 2022 ? (cLen >= 34 && hLen >= 11 && eLen >= 11) : (cLen >= 45);
  };
  if (key && isOk(KOREAN_PARSED_ANSWERS_CACHE[key])) {
    return res.json(KOREAN_PARSED_ANSWERS_CACHE[key]);
  }
  const preset = KOREAN_EXAM_PRESETS[key] || KOREAN_EXAM_URL_CACHE[key] || {};
  const pdfUrl = preset.answerPdfUrl || preset.questionPdfUrl || '';
  if (pdfUrl && typeof extractKoreanAnswersFromPdfOnServer === 'function') {
    const ext = await extractKoreanAnswersFromPdfOnServer(yN, type, pdfUrl);
    if (isOk(ext)) return res.json(ext);
  }
  return res.json({ ok: false, commonMap: {}, hwajakMap: {}, eonmaeMap: {} });
});

function getLocalKoreanPdfPath(year, type, kind) {
  const safeY = String(year || '').replace(/[^0-9]/g, '');
  const safeT = String(type || '').replace(/[^가-힣a-zA-Z0-9]/g, '');
  const safeK = kind === 'a' ? 'a' : 'q';
  if (!safeY || !safeT) return '';
  const pubPath = path.join(__dirname, 'public', 'pdfs', `${safeY}_${safeT}_${safeK}.pdf`);
  if (fs.existsSync(pubPath)) return pubPath;
  const cacheDir = path.join(__dirname, 'data', 'korean_pdfs');
  try { if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) {}
  return path.join(cacheDir, `${safeY}_${safeT}_${safeK}.pdf`);
}

async function prewarmKoreanExamCache() {
  try {
    const years = [2027, 2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017];
    const types = ['수능', '9월', '6월'];
    for (const y of years) {
      for (const t of types) {
        const key = `${y}_${t}`;
        const ca = KOREAN_PARSED_ANSWERS_CACHE[key];
        const ok = ca && (y >= 2022
          ? (Object.keys(ca.commonMap || {}).length >= 34 && Object.keys(ca.hwajakMap || {}).length >= 11 && Object.keys(ca.eonmaeMap || {}).length >= 11)
          : (Object.keys(ca.commonMap || {}).length >= 45));
        if (ok) continue;
        const preset = KOREAN_EXAM_PRESETS[key] || {};
        let qUrl = preset.questionPdfUrl || '';
        let aUrl = preset.answerPdfUrl || '';
        if (!qUrl || !aUrl) {
          const hr = await searchHoraengKoreanPdf(y, t).catch(() => ({ mun: '', hsj: '' }));
          if (!qUrl) qUrl = hr.mun || (await searchEbsiKoreanPdf(y, t, 'mun').catch(() => ''));
          if (!aUrl) aUrl = hr.hsj || (await searchEbsiKoreanPdf(y, t, 'hsj').catch(() => ''));
        }
        if (qUrl || aUrl) {
          KOREAN_EXAM_URL_CACHE[key] = { ok: true, year: String(y), type: t, questionPdfUrl: qUrl, answerPdfUrl: aUrl, ebsiUrl: 'https://www.ebsi.co.kr/ebs/xip/xipc/previousPaperList.ebs?targetCd=D300' };
          const targetA = aUrl || qUrl;
          if (targetA) await extractKoreanAnswersFromPdfOnServer(y, t, targetA).catch(() => null);
        }
        await new Promise(r => setTimeout(r, 2500));
      }
    }
  } catch (e) {}
}
setTimeout(() => { prewarmKoreanExamCache(); }, 8000);

app.post('/api/korean-parse-answers', async (req, res) => {
  const _reqKey = req.body && req.body.year && req.body.type ? `${req.body.year}_${req.body.type}` : '';
  if (_reqKey && KOREAN_PARSED_ANSWERS_CACHE[_reqKey]) {
    const cached = KOREAN_PARSED_ANSWERS_CACHE[_reqKey];
    const yN = Number(req.body.year || 2026);
    const hasAll = yN >= 2022
      ? (Object.keys(cached.commonMap || {}).length >= 34 && Object.keys(cached.hwajakMap || {}).length >= 11 && Object.keys(cached.eonmaeMap || {}).length >= 11)
      : (Object.keys(cached.commonMap || {}).length >= 45);
    if (hasAll) return res.json(cached);
  }
  res.setHeader('Cache-Control', 'no-store');
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'GEMINI_API_KEY 미설정' });
  }
  const { year, type, answerText, pageImageBase64, pageImagesBase64 } = req.body || {};
  const yNum = Number(year || 2026);
  const isElective = yNum >= 2022;
  const typeLabel = type === '수능' ? '대학수학능력시험(수능)' : `${type || ''} 학력평가`;

  const prompt = isElective
    ? `다음은 ${yNum}학년도 ${typeLabel} 국어 영역 공식 정답표/해설지 자료입니다.
제공된 이미지와 텍스트에서 **홀수형 기준**으로:
1) 공통과목(1~34번)
2) 화법과 작문(35~45번)
3) 언어와 매체(35~45번)
모든 문항의 정답을 빠짐없이 정확히 추출해 원문자(①,②,③,④,⑤) JSON으로 출력하세요.
[절대 규칙]
- 이미지나 텍스트에 실제로 보이는 정답만 추출하고, 없는 과목/문항은 {}로 두세요.
- 화법과 작문 답을 언어와 매체에 복사하지 마세요.
JSON 형식만 출력:
{"common":{"1":"①"},"hwajak":{"35":"④"},"eonmae":{"35":"②"}}

[정답/해설지 텍스트]
${String(answerText || '').slice(0, 14000)}`
    : `다음은 ${yNum}학년도 ${typeLabel} 국어 영역 공식 정답표/해설지 자료입니다.
자료에서 **홀수형 기준** 1~45번 공식 정답을 빠짐없이 원문자(①,②,③,④,⑤) JSON으로 출력하세요.
JSON 형식만 출력:
{"common":{"1":"①"}}

[정답/해설지 텍스트]
${String(answerText || '').slice(0, 14000)}`;

  const parts = [{ text: prompt }];
  const imgsList = Array.isArray(pageImagesBase64) ? pageImagesBase64.slice(0, 4) : [];
  if (imgsList.length === 0 && typeof pageImageBase64 === 'string' && pageImageBase64.length > 100) {
    imgsList.push(pageImageBase64);
  }
  for (const imgB64 of imgsList) {
    if (typeof imgB64 === 'string' && imgB64.length > 100) {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: imgB64.replace(/^data:image\/\w+;base64,/, '') } });
    }
  }

  let result = await callGeminiWithFallback(
    apiKey,
    { contents: [{ parts }], generationConfig: { temperature: 0.0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } } },
    imgsList.length > 0 ? 'vision' : 'chat'
  );
  if (!result || !result.text) {
    result = await callGeminiWithFallback(
      apiKey,
      { contents: [{ parts }], generationConfig: { temperature: 0.0, maxOutputTokens: 2048 } },
      imgsList.length > 0 ? 'vision' : 'chat'
    );
  }
  if (!result || !result.text) {
    return res.status(502).json({ ok: false, error: '정답 추출 실패' });
  }
  try {
    const m = result.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('JSON 없음');
    const parsed = JSON.parse(m[0]);
    const norm = (obj) => {
      const out = {};
      const cMap = { '1':'①','2':'②','3':'③','4':'④','5':'⑤','①':'①','②':'②','③':'③','④':'④','⑤':'⑤' };
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          const qn = String(Number(k));
          const sv = String(v || '').trim();
          if (qn !== 'NaN' && cMap[sv]) out[qn] = cMap[sv];
        }
      }
      return out;
    };
    const sanity = (mp) => {
      const vals = Object.values(mp);
      if (vals.length >= 6 && new Set(vals).size <= 1) return {};
      let run = 1;
      for (let i = 1; i < vals.length; i++) {
        run = (vals[i] === vals[i - 1]) ? run + 1 : 1;
        if (run >= 7) return {};
      }
      return mp;
    };
    const outObj = {
      ok: true,
      commonMap: sanity(norm(parsed.common)),
      hwajakMap: sanity(norm(parsed.hwajak)),
      eonmaeMap: sanity(norm(parsed.eonmae))
    };
    const stillMissing = isElective
      ? (Object.keys(outObj.commonMap).length < 34 || Object.keys(outObj.hwajakMap).length < 11 || Object.keys(outObj.eonmaeMap).length < 11)
      : (Object.keys(outObj.commonMap).length < 45);
    if (stillMissing && yNum >= 2017 && yNum <= 2027) {
      try {
        const examKw = type === '수능' ? '수능' : `${type} 모의평가`;
        const qStr = `${yNum}학년도 ${examKw} 국어 정답표 홀수형 ${isElective ? '화법과 작문 언어와 매체 35번 45번' : '1번 45번'}`;
        const qHw = isElective ? `${yNum}학년도 ${examKw} 국어 화법과 작문 35번 45번 정답 홀수형` : qStr;
        const [nv, dm, gn] = await Promise.all([
          fetchNaverSearchWithArticles(qStr),
          fetchDaumSearchWithArticles(qHw),
          fetchGoogleNewsRssWithArticles(qStr)
        ]);
        const webTxt = [nv, dm, gn].filter(Boolean).join('\n').slice(0, 24000);
        if (webTxt.length > 80) {
          const webPrompt = isElective
            ? `아래 웹 검색 결과에서 ${yNum}학년도 ${typeLabel} 국어 영역 홀수형 정답(공통 1~34, 화법과 작문 35~45, 언어와 매체 35~45)을 원문자(①~⑤) JSON으로 추출하세요.\nJSON만 출력: {"common":{"1":"①"},"hwajak":{"35":"④"},"eonmae":{"35":"②"}}\n[검색 결과]\n${webTxt}`
            : `아래 웹 검색 결과에서 ${yNum}학년도 ${typeLabel} 국어 영역 홀수형 1~45번 정답을 원문자(①~⑤) JSON으로 추출하세요.\nJSON만 출력: {"common":{"1":"①"}}\n[검색 결과]\n${webTxt}`;
          const wRes = await callGeminiWithFallback(
            apiKey,
            { contents: [{ parts: [{ text: webPrompt }] }], generationConfig: { temperature: 0.0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } } },
            'chat'
          );
          const wm = wRes && wRes.text && wRes.text.match(/\{[\s\S]*\}/);
          if (wm) {
            const wp = JSON.parse(wm[0]);
            outObj.commonMap = Object.assign({}, sanity(norm(wp.common)), outObj.commonMap);
            if (isElective) {
              outObj.hwajakMap = Object.assign({}, sanity(norm(wp.hwajak)), outObj.hwajakMap);
              outObj.eonmaeMap = Object.assign({}, sanity(norm(wp.eonmae)), outObj.eonmaeMap);
            }
          }
        }
      } catch (we) {}
    }
    if (_reqKey && Object.keys(outObj.commonMap).length >= 25) {
      KOREAN_PARSED_ANSWERS_CACHE[_reqKey] = outObj;
      saveParsedAnswersCache();
    }
    res.json(outObj);
  } catch (e) {
    res.status(502).json({ ok: false, error: '정답 JSON 파싱 실패' });
  }
});


const KOREAN_MOCK_JOBS = {};

async function runHighQualityKoreanMockJob(jobId, { title, elective, userPrompt, apiKey }) {
  const job = KOREAN_MOCK_JOBS[jobId];
  const updateJob = (pct, msg) => {
    if (!job) return;
    job.pct = pct;
    job.msg = msg;
    job.updatedAt = Date.now();
  };

  if (!global._korMockRecentSeeds) global._korMockRecentSeeds = [];
  const pickFresh = (pool, count = 1) => {
    const recent = new Set(global._korMockRecentSeeds);
    const avail = pool.filter(x => !recent.has(x));
    const src = avail.length >= count ? avail : pool;
    const shuffled = [...src].sort(() => Math.random() - 0.5);
    const chosen = shuffled.slice(0, count);
    global._korMockRecentSeeds.push(...chosen);
    if (global._korMockRecentSeeds.length > 40) {
      global._korMockRecentSeeds = global._korMockRecentSeeds.slice(-40);
    }
    return chosen;
  };
  const [tTheory] = pickFresh(['독서의 인지적 과정과 스키마', '비판적 읽기와 논증 타당성 평가', '매체 환경 변화와 심층 독해 전략', '상호텍스트적 읽기와 의미 재구성', '독해 중 자기 점검과 추론 조정'], 1);
  const [tHum] = pickFresh(['조선 후기 실학파의 인식론과 이용후생(가)/(나)', '고대 동양의 예악 사상과 근대 시민 윤리(가)/(나)', '현상학과 해석학의 의미 이해 이론(가)/(나)', '언어철학의 지시 이론과 화용론(가)/(나)', '미학에서의 숭고 개념과 현대 예술론(가)/(나)', '역사 서술의 객관성과 사료 해석(가)/(나)'], 1);
  const [tSci] = pickFresh(['세포 내 자가포식과 리소좀 분해 메커니즘', '열역학 제2법칙과 비평형 통계역학의 엔트로피', '디지털 영상 압축과 이산 코사인 변환(DCT)', '항생제 내성 박테리아의 유전자 수평 전달', '인공신경망의 역전파와 경사 소실 문제', '대기 복사 평형과 구름 알베도 피드백', '양자 암호 키 분배와 광자 편광 상태'], 1);
  const [tLaw] = pickFresh(['행정행위의 부관과 비례의 원칙', '계약 해제와 원상회복 의무 및 손해배상', '불완전 경쟁 시장의 가격 차별과 후생 변화', '중앙은행의 통화 정책과 유동성 함정', '저작권법상 공정이용 법리와 변형적 이용', '채권자취소권과 사해행위의 성립 요건'], 1);
  const [wModNov] = pickFresh(['염상섭 계열의 도시 지식인 심리 소설', '채만식·박태원 계열의 풍자·세태 소설', '황순원·오영수 계열의 서정적 단편 소설', '김승옥·이청준 계열의 1960년대 내면 의식 소설', '박완서·윤흥길 계열의 가족사·현대사 소설'], 1);
  const [wGal] = pickFresh(['조선 전기 강호가도 시조/가사 + 현대 수필', '조선 후기 사설시조 + 고전 한문 수필', '고려 속요/경기체가 + 현대 비평 수필', '유배 가사 + 현대 산문 수필'], 1);
  const [wClsNov] = pickFresh(['영웅 군담 소설(새로운 인물·전투 서사)', '가정·쟁총형 고전 소설(새로운 가문 서사)', '애정·전기 소설(새로운 만남과 시련 서사)', '판소리계 우화·풍자 소설(새로운 풍자 서사)'], 1);
  const [wModPoem] = pickFresh(['생명파·자연 서정 현대시 2편', '모더니즘·도시 감각 현대시 2편', '민중·역사 성찰 현대시 2편', '전통 정서·존재 탐구 현대시 2편'], 1);

  const uniquePromptSeed = `출제 고유 시드: ${Date.now()}-${Math.floor(Math.random()*100000)}
이번 회차 배정 제재(이전 회차와 겹치지 않는 새로운 지문·작품):
- 독서 이론: ${tTheory}
- 인문·사회(가/나): ${tHum}
- 과학·기술: ${tSci}
- 법·경제: ${tLaw}
- 현대소설: ${wModNov}
- 갈래복합: ${wGal}
- 고전소설: ${wClsNov}
- 현대시(가/나): ${wModPoem}`;

  const commonPolicy = `당신은 한국교육과정평가원(KICE) 수능 국어 영역 수석 출제위원입니다.
2017~2027학년도 수능(특히 최신 2027학년도 수능 국어)의 출제 기조, 실제 수능 지문 분량과 논리 밀도, 선지 함정 패턴(인과 역전, 조건 누락, 범위 확대/축소, 개념 뒤바꾸기, <보 기> 외적 준거 적용), 시각 자료(도표·그래프·매체 화면) 활용 방식을 극한으로 정밀하게 반영해 출제하세요.
목표 난이도는 1등급 컷 원점수 84~91점(변별력 있는 중상~상 난이도, [3점] 고난도 추론·적용 문항 다수 포함)입니다.

[분량 · 배점(10개년 기출 기준) · 문학 출처 필수 조건]
- 배점은 실제 수능 국어 10개년 기준과 동일하게 **총 100점 = 2점 35문항 + 3점 10문항**으로 엄격히 맞추세요(독서 4문항, 문학 4문항, 선택과목 2문항에 points:3 배정, 나머지 35문항은 points:2).
- 문학 지문([18~21] 현대소설, [22~26] 갈래복합, [27~30] 고전소설, [31~34] 현대시 (가)/(나))의 각 작품 끝에는 실제 수능처럼 반드시 출처 표기 줄(예: "― 김승옥, 「무진기행」" 또는 "― 작자 미상, 「유충렬전」")을 넣으세요. 특히 [31~34] 현대시는 절대 32번 문항의 <보 기> 안에 시를 넣지 말고, 반드시 [31~34] 지문(passage.header/body)에 (가), (나) 두 편을 배치하세요.
- 본문·발문 문자열에 <b>, <i> 같은 HTML 태그를 쓰지 마세요(어휘 문항 선지 ①~⑤의 비교 대상 단어에만 <u>단어</u> 밑줄을 허용하며, 그 외에는 ㉠~㉤ 또는 ⓐ~ⓔ 표기 사용).
- 독서 지문은 실제 2026·2027 수능 PDF와 동일한 문단 수와 분량으로 작성하세요(2문단짜리 짧은 지문 절대 금지!):
  · [1~3] 독서 이론: **최소 3~4문단, 1,000~1,200자**
  · [4~9] 인문·사회 (가)/(나): **(가) 3~4문단(1,300~1,500자) + (나) 3~4문단(1,300~1,500자) = 총 6~8문단, 2,600~3,000자**
  · [10~13] 과학·기술: **4~5문단, 1,750~2,100자**
  · [14~17] 법·경제: **4~5문단, 1,750~2,100자**
  문단 내에 [A], [B] 구간 표지나 ㉠~㉤, ⓐ~ⓔ 표지를 실제 수능처럼 적절히 배치하세요.
- 문학 지문도 실제 수능처럼 인물 대사·서술·시 연·고전 어휘 현대어 풀이(예: 즈믄 해=천 년), [중략 줄거리]가 살아있는 완성도 높은 분량으로 작성하세요.
- box 필드(<보 기> 내용) 안에는 절대 "<보 기>"나 "<보기>" 제목 글자를 쓰지 마세요.
- 독서 어휘 문항은 실제 2026·2027 수능 PDF처럼 **[1~3] 독서 이론에는 절대 출제하지 말고**, [4~9] (가)/(나) 지문 마지막 문항(9번)에 1문항 + [10~13] 또는 [14~17] 지문 마지막 문항(13번 또는 17번)에 1문항, 총 2문항만 출제하세요(box는 반드시 빈 문자열 ""):
  · 유형 1(다의어 문맥 의미): 지문 내 1개 단어에만 ⓐ를 표기하고, 발문은 반드시 **"문맥상 ⓐ와 가장 가까운 의미로 쓰인 것은?"**으로만 쓰세요(절대 "다음은 위 글을 읽은 학생이 어휘 학습을 위해 정리한 내용이다." 같은 불필요한 서두나 '매몰되어' 같은 단어 병기를 넣지 말 것!). 선지 ①~⑤에는 **절대 ⓐ 기호를 넣지 말고** 5개 선지 모두에서 의미를 비교할 핵심 서술어/단어에 반드시 <u>...</u> 밑줄을 쳐서 제시하세요(예: ① 우리 대표팀은 경기 초반의 열세를 딛고 역전승을 <u>거머쥐었다</u>.).
  · 유형 2(어휘 바꿔 쓰기, 13번 또는 17번에 반드시 1문항 출제): 지문 내 5개 어휘에 반드시 ⓐ 단어~ⓔ 단어를 표기하고, 발문은 "문맥상 ⓐ～ⓔ를 바꿔 쓰기에 가장 적절한 것은?"으로 하며, 선지 ①~⑤는 실제 2027 수능 13번처럼 반드시 **"① ⓐ: 소요(所要)된다"**, **"② ⓑ: 부과(賦課)된다"** 형식으로 ⓐ~ⓔ 기호와 한자어(또는 대체어)만 제시하세요(절대 "① 수반된다: 동반된다"처럼 기호를 빼거나 '->' 화살표를 쓰지 마세요!).
- <보 기> 안에 빈칸 추론(예: '특히 ㉠ ________.')을 넣을 때는 반드시 긴 밑줄 빈칸을 포함하고, 선지 ①~⑤는 빈칸 문맥에 자연스럽게 이어지는 완성된 문장형(또는 서술절)으로 끝맺으세요.
- stem 안에 [학습 활동] 본문이나 비교표를 섞어 넣지 말고, 추가 자료는 box 필드에 넣으세요.
- 모든 문항의 stem 앞에는 반드시 문항 번호("1. ", "2. " ... "45. ")를 붙이고, 지정된 범위의 모든 번호를 1문항도 빠짐없이 출제하세요.

[시의적절한 시각 자료(visual) 및 기출 정합성 필수 지침]
- 실제 평가원 기출처럼 **표·그래프·도식 아래에는 절대 '출처: ...' 문구를 넣지 마세요** (caption 필드 사용 금지). 문학 작품 끝의 '― 작가명, 「작품명」'만 표기합니다.
- 독서 지문(passage.visual)에는 굳이 그림·도식을 넣지 마세요(기본값 null). 문항 풀이에 그림·표·그래프가 꼭 필요한 경우에만 해당 문항의 <보 기>(question.visual) 안에만 간결하게 넣으세요.
- 화법과 작문([35~37] 발표, [43~45] 자료 활용)과 언어와 매체([40~45] 누리 소통망 대화방·인터넷 게시판/기사)에는 실제 기출처럼 visual을 적극 활용하세요.
- 한국어 단어 중간에 한자를 섞어 쓰지 마세요(예: '무謂손실' 금지 -> '무위손실' 또는 '무위손실(無爲損失)').
- visual 객체는 아래 5가지 타입 중 가장 적절한 것을 선택해 지문(passage.visual) 또는 문항(question.visual)에 넣을 수 있습니다:
  1) {"type":"chart","chartType":"bar"|"line"|"pie","title":"[자료 1] 제목","unit":"단위(%)","labels":["항목1","항목2","항목3"],"series":[{"name":"계열1","values":[30,50,20]}]}
  2) {"type":"diagram","title":"<그림> 제목","nodes":[{"id":"A","label":"핵심 개념 A"},{"id":"B","label":"핵심 개념 B"},{"id":"C","label":"결과 C"}],"edges":[{"from":"A","to":"B","label":"조건/작용"},{"from":"B","to":"C","label":"산출"}]}
  3) {"type":"table","title":"<표> 제목","headers":["구분","내용1","내용2"],"rows":[["항목A","값1","값2"],["항목B","값3","값4"]]}
  4) {"type":"chat","title":"누리 소통망 대화방 (동아리 발표 준비)","messages":[{"sender":"윤호","time":"오후 4:10","text":"발표 자료 초안 공유할게."},{"sender":"서연","time":"오후 4:12","text":"여기에 그래프를 추가하면 좋겠어."}]}
  5) {"type":"webpage","site":"○○일보 / ○○고등학교 누리집","title":"기사·게시글 제목","meta":"작성자 ○○○ | 2026.11.15. | 조회 412","body":"게시글/기사 본문 내용","comments":["댓글1: ...","댓글2: ..."]}

[회차별 다양성 지침]
${uniquePromptSeed}
[추가 요청사항]
${userPrompt || '2027학년도 수능 국어와 동등한 최고 난이도·완성도로 균형 있게 출제'}

반드시 아래 순수 JSON 형식만 출력하세요:
{"passages":[{"range":"[1~3]","header":"[1~3] 다음 글을 읽고 물음에 답하시오.","body":"지문 본문(문단 구분은 \n\n, ㉠~㉤, ⓐ~ⓔ 포함)","visual":null,"questions":[{"no":1,"stem":"1. 발문","box":"<보 기> 내용 없으면 빈 문자열","visual":null,"points":2,"choices":["① 선지1","② 선지2","③ 선지3","④ 선지4","⑤ 선지5"],"answer":"③","explain":"정답 및 오답 핵심 근거 2~3줄"}]}]}`;

  const safeParsePassages = (txt) => {
    if (!txt) return [];
    let cleaned = String(txt).replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const tryExtract = (raw) => {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.passages)) return parsed.passages;
      if (parsed && Array.isArray(parsed.data)) return parsed.data;
      return [];
    };
    const m = cleaned.match(/\{[\s\S]*\}/) || cleaned.match(/\[[\s\S]*\]/);
    const candidate = m ? m[0] : cleaned;
    try {
      return tryExtract(candidate);
    } catch (e) {
      try {
        const fixed = candidate.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u0019]+/g, ' ');
        return tryExtract(fixed);
      } catch (e2) {
        const recovered = [];
        const pMatches = candidate.match(/\{"range"\s*:[\s\S]*?"questions"\s*:\s*\[[\s\S]*?\]\s*\}/g) || [];
        for (const pm of pMatches) {
          try { recovered.push(JSON.parse(pm.replace(/,\s*([}\]])/g, '$1'))); } catch (e3) {}
        }
        return recovered;
      }
    }
  };

  const partErrors = [];
  const callGeminiJson = async (promptText) => {
    const configs = [
      { temperature: 0.78, maxOutputTokens: 16384, responseMimeType: 'application/json' },
      { temperature: 0.72, maxOutputTokens: 8192, responseMimeType: 'application/json' },
      { temperature: 0.65, maxOutputTokens: 8192 }
    ];
    for (const genCfg of configs) {
      const r = await callGeminiWithFallback(
        apiKey,
        { contents: [{ parts: [{ text: promptText }] }], generationConfig: genCfg },
        'chat'
      );
      if (r && r.text) {
        const list = safeParsePassages(r.text);
        if (list.length > 0) return list;
        partErrors.push('JSON 파싱 실패');
      } else if (r && r.error) {
        partErrors.push(r.error);
      }
      await new Promise(res => setTimeout(res, 1200));
    }
    return [];
  };

  // Pass 1: Draft + Pass 2: KICE Review Committee Refinement (self-critique, expand short texts, fix dual-answers, verify visuals & modern formatting)
  const draftAndRefinePart = async (partName, partDesc, expectedRange) => {
    const draftPrompt = `${commonPolicy}\n\n[이번에 출제할 파트: ${partName}]\n${partDesc}`;
    const draft = await callGeminiJson(draftPrompt);
    if (!draft.length) return [];

    await new Promise(res => setTimeout(res, 1000));
    const reviewPrompt = `당신은 한국교육과정평가원(KICE) 수능 국어 검토위원장입니다.
아래 출제 초안(${partName}, 문항 범위 ${expectedRange})을 최고 수준으로 정밀 검수하고 보완해 최종 JSON으로 출력하세요.
[검토 및 수정 체크리스트]
1. 지문 분량이 실제 2027 수능 PDF처럼 충분히 길고 논리적으로 치밀한가? 짧거나 피상적인 지문은 개념 설명과 추론 단서를 추가해 30% 이상 더 깊고 길게 보강하세요.
2. ${expectedRange} 범위의 모든 문항 번호가 1문항도 빠짐없이 들어있는가? 빠진 번호가 있으면 보충하세요.
3. 각 문항의 정답 선지가 지문·<보 기>·visual 자료 근거와 100% 일치하고, 나머지 4개 오답 선지가 복수 정답 여지 없이 명확히 배제되는가? 매력적 오답(인과 역전, 조건 누락, 범위 확대)을 정교하게 다듬으세요.
4. 어휘 문항에는 <보 기>를 넣지 말고("box":""), box 문자열 앞의 중복 "<보 기>" 문구는 제거하세요. stem 안의 [학습 활동] 본문은 box로 분리하세요.
5. 과학·기술/법·경제 독서나 화법과 작문/언어와 매체 파트에서 지문/문항에 언급된 그래프·표·도식·메신저·웹페이지가 visual 필드에 정확히 구조화되어 있는지 확인하고, 누락되었거나 수치가 선지와 어긋나면 수정하세요.

[검수 대상 초안 JSON]
${JSON.stringify({ passages: draft }).slice(0, 26000)}

동일한 JSON 스키마({"passages":[...]})로 완벽하게 수정된 최종본만 출력하세요:`;
    const refined = await callGeminiJson(reviewPrompt);
    return refined.length > 0 ? refined : draft;
  };

  const ensureRangeComplete = async (partName, partPassages, startNo, endNo, partDesc) => {
    let list = Array.isArray(partPassages) ? partPassages : [];
    const getMissing = (arr) => {
      const seen = new Set();
      arr.forEach(p => (p.questions || []).forEach(q => {
        const n = Number(q.no || 0);
        if (n >= startNo && n <= endNo) seen.add(n);
      }));
      const miss = [];
      for (let n = startNo; n <= endNo; n++) {
        if (!seen.has(n)) miss.push(n);
      }
      return miss;
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const missing = getMissing(list);
      if (missing.length === 0 && list.length > 0) break;

      await new Promise(r => setTimeout(r, 900));
      if (list.length === 0) {
        const retryPrompt = `${commonPolicy}\n\n[필수 출제 파트: ${partName}]\n${partDesc}\n반드시 ${startNo}번부터 ${endNo}번까지 총 ${endNo - startNo + 1}문항을 1문항도 빠짐없이 출제하세요.`;
        const retried = await callGeminiJson(retryPrompt);
        if (retried.length > 0) list = retried;
        continue;
      }

      const existingSummary = list.map((p, idx) => {
        const qNos = (p.questions || []).map(q => Number(q.no || 0)).filter(Boolean).join(',');
        return `[지문 ${idx + 1}] range=${p.range || ''} (기존 문항: ${qNos})\n${String(p.body || '').slice(0, 2200)}`;
      }).join('\n\n');

      const fillPrompt = `${commonPolicy}\n\n[누락 문항 긴급 보충: ${partName}]
현재 ${startNo}~${endNo}번 중 다음 문항 번호가 누락되었습니다: [${missing.join(', ')}번]
아래 기존 지문 내용을 그대로 유지하고, 누락된 [${missing.join(', ')}번] 문항만 기존 지문에 어울리게 새로 출제해 JSON으로 출력하세요.
(반드시 questions 배열에 누락된 번호 ${missing.join(', ')}를 모두 포함하고, 기존 지문의 range와 맞춰 주세요.)

[기존 지문 요약]
${existingSummary}

출력 JSON 형식: {"passages":[{"range":"[해당 범위]","header":"...","body":"","questions":[{"no":${missing[0]},"stem":"${missing[0]}. 발문","box":"","points":2,"choices":["① ...","② ...","③ ...","④ ...","⑤ ..."],"answer":"③","explain":"..."}]}]}`;
      const filled = await callGeminiJson(fillPrompt);
      if (filled.length > 0) {
        filled.forEach(fp => {
          const fqs = Array.isArray(fp.questions) ? fp.questions.filter(q => missing.includes(Number(q.no || 0))) : [];
          if (!fqs.length) return;
          // Attach to matching existing passage by range or closest question numbers
          let target = list.find(ep => ep.range && fp.range && ep.range.replace(/\s+/g, '') === fp.range.replace(/\s+/g, ''));
          if (!target) {
            const fFirst = Number(fqs[0].no || 0);
            target = list.reduce((best, ep) => {
              const eFirst = Number((ep.questions && ep.questions[0] && ep.questions[0].no) || 0);
              const bFirst = Number((best.questions && best.questions[0] && best.questions[0].no) || 0);
              return Math.abs(eFirst - fFirst) < Math.abs(bFirst - fFirst) ? ep : best;
            }, list[0]);
          }
          if (target) {
            target.questions = [...(target.questions || []), ...fqs];
          } else {
            list.push(fp);
          }
        });
      }
    }
    return list;
  };

  try {
    updateJob(8, '1단계: 독서 이론 · 인문·사회(가/나) 지문 심층 출제 및 검토 중...');
    let p1a = await draftAndRefinePart('독서 1~9번', '공통과목 독서 1~9번(총 9문항): [1~3] 독서 이론(3~4문단, 1,000~1,200자, 3문항), [4~9] 인문·사회 주제 통합 (가)/(나)((가) 3~4문단 + (나) 3~4문단 합산 2,600~3,000자, 6문항, 9번은 어휘 문항, [3점] 포함).', '1~9번');
    p1a = await ensureRangeComplete('독서 1~9번', p1a, 1, 9, '공통과목 독서 1~9번(총 9문항): [1~3] 독서 이론, [4~9] 인문·사회 (가)/(나).');

    updateJob(26, '2단계: 과학·기술 · 법·경제 고난도 추론 지문 출제 및 검토 중...');
    await new Promise(r => setTimeout(r, 1000));
    let p1b = await draftAndRefinePart('독서 10~17번', '공통과목 독서 10~17번(총 8문항): [10~13] 과학·기술(4~5문단, 1,800~2,100자, 4문항, [3점] 포함 — 과도한 이과 전공 지식·수식·전문 약어 배제, 지문 속 친절한 개념 정의와 직관적 비유·인과 설명만으로 문과 학생도 논리적으로 충분히 풀 수 있는 적정 난이도 유지), [14~17] 법·경제(4~5문단, 1,800~2,100자, 4문항, [3점] 포함).', '10~17번');
    p1b = await ensureRangeComplete('독서 10~17번', p1b, 10, 17, '공통과목 독서 10~17번(총 8문항): [10~13] 과학·기술, [14~17] 법·경제.');

    updateJob(45, '3단계: 현대소설 · 갈래 복합 작품 선정 및 문항 검토 중...');
    await new Promise(r => setTimeout(r, 1000));
    let p2a = await draftAndRefinePart('문학 18~26번', '공통과목 문학 18~26번(총 9문항): [18~21] 현대소설(2,400~2,800자, 7~10문단, 인물 대화·심리 서술·[A]/[B] 구간 포함, 4문항), [22~26] 갈래 복합 (가) 고전시가+(나) 현대시/수필(1,600자+, 5문항). 반드시 26번까지만 출제하세요.', '18~26번');
    p2a = await ensureRangeComplete('문학 18~26번', p2a, 18, 26, '공통과목 문학 18~26번(총 9문항): [18~21] 현대소설, [22~26] 갈래 복합.');

    updateJob(64, '4단계: 고전소설 · 현대시(가/나) 출제 및 <보기> 검토 중...');
    await new Promise(r => setTimeout(r, 1000));
    let p2b = await draftAndRefinePart('문학 27~34번', '공통과목 문학 27~34번(총 8문항): [27~30] 고전소설(2,400~2,800자, 7~10문단, 인물 대화·고전 문체·사건 전개·[중략 줄거리]·어휘 각주 포함, 4문항), [31~34] 현대시 (가)/(나) 2편 전문(passage.header="[31~34] 다음 글을 읽고 물음에 답하시오.", passage.body에 (가), (나) 시 배치 — 절대 문항 <보 기> 안에 시를 넣지 말 것!) 및 4문항.', '27~34번');
    p2b = await ensureRangeComplete('문학 27~34번', p2b, 27, 34, '공통과목 문학 27~34번(총 8문항): [27~30] 고전소설, [31~34] 현대시 (가)/(나).');

    updateJob(82, `5단계: 선택과목(${elective} 35~45번) 출제 및 최종 45문항 검수 중...`);
    await new Promise(r => setTimeout(r, 1000));
    const p3Spec = elective === '언어와 매체'
      ? `선택과목 '언어와 매체' 35~45번(총 11문항):
  - [35~36] 국어 문법/어문 규정 지문(1,200자+) + 2문항(36번은 <보 기> 자료표 포함 [3점]).
  - 37번, 38번, 39번: 각각 독립 문법·중세국어 문항(<학습 활동> 또는 <보 기>/<자 료> 표 포함).
  - [40~43] (가) 인터넷 방송/온라인 알림 + (나) 학생 블로그·카드뉴스(반드시 visual:{"type":"webpage",...} 또는 diagram 포함, 글자만 출제 금지) + 4문항.
  - [44~45] (가) 누리 소통망 메신저 대화방(반드시 visual:{"type":"chat",...} 포함) + (나) 발표 자료 슬라이드/특집 기사 웹 화면(반드시 visual:{"type":"webpage"|"table"|"chart",...} 포함, 절대 글만 있는 지문 금지) + 2문항.`
      : `선택과목 '화법과 작문' 35~45번(총 11문항):
  - [35~37] 학생 발표(1,100자+, (㉠~㉢ 자료 제시)) + 36번 [자료 1]~[자료 3] visual(diagram/chart/table) 필수 포함 + 3문항.
  - [38~42] (가) 학생들의 대화 + (나) 초고/보고서(합산 2,200자+) + 5문항.
  - [43~45] 작문 상황 + [초고](1,300자+) + 45번 <보 기> 조사 결과 그래프·표(visual:{"type":"chart",...} 필수 포함) + 3문항.`;
    let p3 = await draftAndRefinePart(`선택과목 ${elective} 35~45번`, p3Spec, '35~45번');
    p3 = await ensureRangeComplete(`선택과목 ${elective} 35~45번`, p3, 35, 45, `선택과목 '${elective}' 35~45번(총 11문항)을 빠짐없이 출제하세요.`);

    updateJob(96, '6단계: 1~45번(공통 34문항 + 선택 11문항) 누락 검증 및 조판 정리 중...');
    const seenGlobal = new Set();
    const passages = [...p1a, ...p1b, ...p2a, ...p2b, ...p3].map(p => {
      let rawHdr = String(p.header || p.range || '').trim();
      let rawBody = String(p.body || '').trim();
      const hm = rawHdr.match(/^([\s\S]*?물음에\s*답하시오\.?)[\s\n]+([\s\S]+)$/);
      if (hm) {
        rawHdr = hm[1].trim();
        rawBody = (hm[2].trim() + (rawBody ? '\n\n' + rawBody : '')).trim();
      } else if (rawHdr.length > 90 && !rawBody) {
        rawBody = rawHdr;
        rawHdr = String(p.range || '').trim() + ' 다음 글을 읽고 물음에 답하시오.';
      }
      p = Object.assign({}, p, { header: rawHdr, body: rawBody });
      const qs = Array.isArray(p.questions) ? p.questions.map(q => {
        const no = Number(q.no || 0);
        if (no < 1 || no > 45 || seenGlobal.has(no)) return null;
        seenGlobal.add(no);
        let stem = String(q.stem || '').replace(/\s*\[[23]점\]\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (no > 0 && !new RegExp('^' + no + '\\s*[\\.\\)]').test(stem)) {
          stem = `${no}. ${stem}`;
        }
        let qVisual = q.visual || null;
        let rawBoxVal = q.box;
        if (rawBoxVal && typeof rawBoxVal === 'object') {
          if (rawBoxVal.type && !qVisual) {
            qVisual = rawBoxVal;
            rawBoxVal = '';
          } else if (Array.isArray(rawBoxVal)) {
            rawBoxVal = rawBoxVal.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join('\n');
          } else {
            rawBoxVal = Object.entries(rawBoxVal).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
          }
        }
        let box = String(rawBoxVal || '').replace(/\[object Object\]/g, '').replace(/^\s*(?:<\s*보\s*기\s*>|\[\s*보\s*기\s*\])\s*/i, '').trim();
        let choices = Array.isArray(q.choices) ? q.choices.map(c => String(c || '')) : [];
        if (/문맥상\s*[ⓐ-ⓔ]|문맥적\s*의미/.test(stem)) {
          stem = stem
            .replace(/^(\d+\.\s*)다음은\s*위\s*글을\s*읽은\s*학생이\s*어휘\s*학습을\s*위해\s*정리한\s*내용이다\.\s*/i, '$1')
            .replace(/([ⓐ-ⓔ])\s*['"‘’“”][가-힣]+['"‘’“”]/g, '$1');
          if (/바꿔\s*쓰기/.test(stem)) {
            stem = stem.replace(/문맥상\s*([ⓐ-ⓔ])(?!\s*[~～-])\s*(?:을|를)?\s*바꿔\s*쓰기에/, '문맥상 ⓐ～ⓔ를 바꿔 쓰기에');
            const symList = ['ⓐ', 'ⓑ', 'ⓒ', 'ⓓ', 'ⓔ'];
            const cNums = ['①', '②', '③', '④', '⑤'];
            choices = choices.map((cs, ci) => {
              const arrM = cs.match(/^\s*([①②③④⑤])\s*([ⓐ-ⓔ])\s*[:：]?[\s\S]*?(?:->|→)\s*(.+)$/);
              if (arrM) {
                return `${arrM[1]} ${arrM[2]}: ${arrM[3].replace(/<\/?u>/gi, '').trim()}`;
              }
              const noSymM = cs.match(/^\s*([①②③④⑤])\s*(?![ⓐ-ⓔ])[^:：]+[:：]\s*(.+)$/);
              if (noSymM && ci < 5) {
                return `${cNums[ci]} ${symList[ci]}: ${noSymM[2].replace(/<\/?u>/gi, '').trim()}`;
              }
              const parenM = cs.match(/^\s*([①②③④⑤])\s*(?![ⓐ-ⓔ])[가-힣]+\s*\(([^)]+)\)\s*$/);
              if (parenM && ci < 5) {
                return `${cNums[ci]} ${symList[ci]}: ${parenM[2].replace(/<\/?u>/gi, '').trim()}`;
              }
              return cs;
            });
          } else if (/가까운\s*의미|문맥적\s*의미/.test(stem)) {
            choices = choices.map(cs => {
              if (/<u>/i.test(cs)) return cs;
              if (/[ⓐ-ⓔ]\s*[가-힣]+/.test(cs)) return cs.replace(/[ⓐ-ⓔ]\s*([가-힣]+)/g, '<u>$1</u>');
              return cs.replace(/([가-힣]{2,6})([\.!?]?\s*)$/, '<u>$1</u>$2');
            });
          }
        }
        return Object.assign({}, q, { no, stem, box, visual: qVisual, choices });
      }).filter(Boolean).sort((a, b) => a.no - b.no) : [];
      return Object.assign({}, p, { questions: qs });
    }).filter(p => p.questions.length > 0 || (p.body && p.body.length > 50))
      .sort((a, b) => ((a.questions[0] && a.questions[0].no) || 99) - ((b.questions[0] && b.questions[0].no) || 99));

    // Final global 1~45 completeness & choice/answer integrity audit
    const auditMissing = () => {
      const present = new Set();
      passages.forEach(p => {
        p.questions = (p.questions || []).filter(q =>
          q && Number(q.no) >= 1 && Number(q.no) <= 45 &&
          String(q.stem || '').trim().length >= 4 &&
          Array.isArray(q.choices) && q.choices.length === 5 &&
          String(q.answer || '').trim().length >= 1
        );
        p.questions.forEach(q => present.add(Number(q.no)));
      });
      const miss = [];
      for (let n = 1; n <= 45; n++) {
        if (!present.has(n)) miss.push(n);
      }
      return miss;
    };
    const missingGlobal = auditMissing();
    if (missingGlobal.length > 0 && passages.length > 0) {
      updateJob(98, `최종 검수: 누락·불완전 문항(${missingGlobal.join(', ')}번) 자동 복구 중...`);
      const ctxSummary = passages.map(p => {
        const qNos = (p.questions || []).map(q => q.no).join(',');
        return `[${p.range || ''}] (보유 문항: ${qNos})\n${String(p.body || '').slice(0, 1200)}`;
      }).join('\n\n').slice(0, 14000);
      const repairPrompt = `${commonPolicy}\n\n[최종 45문항 무결성 복구]
현재 전체 1~45번 중 다음 번호가 누락되었거나 선지(5개)·정답이 불완전합니다: [${missingGlobal.join(', ')}번]
아래 지문들과 맥락에 맞게 해당 번호(${missingGlobal.join(', ')}) 문항만 5지선다·정답·해설을 완벽히 채워 JSON으로 출력하세요.
[기존 지문]
${ctxSummary}`;
      const repaired = await callGeminiJson(repairPrompt);
      if (repaired.length > 0) {
        repaired.forEach(rp => {
          const rqs = (rp.questions || []).filter(q => missingGlobal.includes(Number(q.no || 0)) && Array.isArray(q.choices) && q.choices.length === 5);
          rqs.forEach(rq => {
            const qn = Number(rq.no);
            let targetP = passages.reduce((best, ep) => {
              const eFirst = Number((ep.questions && ep.questions[0] && ep.questions[0].no) || 99);
              const bFirst = Number((best.questions && best.questions[0] && best.questions[0].no) || 99);
              return Math.abs(eFirst - qn) < Math.abs(bFirst - qn) ? ep : best;
            }, passages[0]);
            if (targetP) {
              targetP.questions = [...(targetP.questions || []).filter(x => Number(x.no) !== qn), rq].sort((a, b) => a.no - b.no);
            }
          });
        });
      }
    }

    // Normalize 3-point count to exactly 10 questions (total 100 points) matching 10-year KICE CSAT standard
    const flatQs = passages.flatMap(p => p.questions || []);
    if (flatQs.length === 45) {
      const targetThree = new Set([6, 8, 12, 16, 21, 25, 30, 34, 39, 44]);
      let threeList = flatQs.filter(q => Number(q.points) === 3);
      if (threeList.length > 10) {
        let excess = threeList.length - 10;
        for (const q of threeList) {
          if (excess <= 0) break;
          if (!targetThree.has(q.no)) { q.points = 2; excess--; }
        }
        threeList = flatQs.filter(q => Number(q.points) === 3);
        while (threeList.length > 10) { threeList.pop().points = 2; }
      } else if (threeList.length < 10) {
        for (const q of flatQs) {
          if (threeList.length >= 10) break;
          if (Number(q.points) !== 3 && (targetThree.has(q.no) || (q.box && q.box.length > 20))) {
            q.points = 3;
            threeList.push(q);
          }
        }
        for (const q of flatQs) {
          if (threeList.length >= 10) break;
          if (Number(q.points) !== 3) { q.points = 3; threeList.push(q); }
        }
      }
      flatQs.forEach(q => { if (Number(q.points) !== 3) q.points = 2; });
    }

    if (passages.length === 0) {
      const detail = [...new Set(partErrors)].slice(0, 3).join(' / ');
      job.status = 'error';
      job.error = `모의고사 생성에 실패했습니다. (${detail || 'AI 응답 파싱 오류'}) 다시 시도해 주세요.`;
      return;
    }
    job.status = 'done';
    job.pct = 100;
    job.msg = '최고 퀄리티 45문항 모의고사 제작 완료!';
    job.result = { ok: true, title, elective, passages };
  } catch (e) {
    job.status = 'error';
    job.error = '모의고사 생성 중 오류가 발생했습니다: ' + (e.message || '');
  }
}

app.post('/api/korean-mock-generate/start', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'GEMINI_API_KEY가 설정되어 있지 않습니다.' });
  }
  const { title = 'AI 자체제작 모의고사 1회', elective = '화법과 작문', userPrompt = '', userId = '' } = req.body || {};
  if (String(userId || '').trim().toLowerCase() !== 'jace48') {
    return res.status(403).json({ ok: false, error: 'AI 모의고사 자체제작은 jace48 계정에서만 이용할 수 있습니다.' });
  }
  const jobId = 'kmock_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  KOREAN_MOCK_JOBS[jobId] = {
    id: jobId,
    status: 'running',
    pct: 3,
    msg: '고품질 모의고사 출제 파이프라인 시작...',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
    error: ''
  };
  // Clean old jobs > 1 hour
  for (const [k, v] of Object.entries(KOREAN_MOCK_JOBS)) {
    if (Date.now() - v.createdAt > 3600000) delete KOREAN_MOCK_JOBS[k];
  }
  runHighQualityKoreanMockJob(jobId, { title, elective, userPrompt, apiKey });
  res.json({ ok: true, jobId });
});

app.get('/api/korean-mock-generate/status/:jobId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const reqUid = String(req.query.userId || '').trim().toLowerCase();
  if (reqUid !== 'jace48') {
    return res.status(403).json({ ok: false, status: 'error', error: '접근 권한이 없습니다.' });
  }
  const job = KOREAN_MOCK_JOBS[req.params.jobId];
  if (!job) {
    return res.status(404).json({ ok: false, error: '출제 작업을 찾을 수 없습니다.' });
  }
  if (job.status === 'done') {
    return res.json({ ok: true, status: 'done', pct: 100, msg: job.msg, data: job.result });
  }
  if (job.status === 'error') {
    return res.json({ ok: false, status: 'error', pct: job.pct, error: job.error });
  }
  res.json({ ok: true, status: 'running', pct: job.pct, msg: job.msg });
});

app.post('/api/korean-mock-generate', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return res.status(503).json({ ok: false, error: 'GEMINI_API_KEY가 설정되어 있지 않습니다.' });
  const { title = 'AI 자체제작 모의고사 1회', elective = '화법과 작문', userPrompt = '', userId = '' } = req.body || {};
  if (String(userId || '').trim().toLowerCase() !== 'jace48') {
    return res.status(403).json({ ok: false, error: 'AI 모의고사 자체제작은 jace48 계정에서만 이용할 수 있습니다.' });
  }
  const jobId = 'kmock_sync_' + Date.now();
  KOREAN_MOCK_JOBS[jobId] = { id: jobId, status: 'running', pct: 3, msg: '출제 중...', createdAt: Date.now(), updatedAt: Date.now(), result: null, error: '' };
  await runHighQualityKoreanMockJob(jobId, { title, elective, userPrompt, apiKey });
  const job = KOREAN_MOCK_JOBS[jobId];
  delete KOREAN_MOCK_JOBS[jobId];
  if (job && job.status === 'done') return res.json(job.result);
  return res.status(502).json({ ok: false, error: (job && job.error) || '모의고사 생성 실패' });
});

app.post('/api/korean-explain', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: '서버에 GEMINI_API_KEY가 설정되어 있지 않습니다.' });
  }
  const { year, type, questionNo, choiceFocus, userQuestion, examText, answerText, pageImagesBase64, chatHistory } = req.body || {};
  const qNo = Number(questionNo || 0);
  const typeLabel = type === '수능' ? '대학수학능력시험(수능)' : `${type || ''} 학력평가`;
  const imgs = Array.isArray(pageImagesBase64) ? pageImagesBase64.slice(0, 3) : [];

  const sysPrompt = `당신은 대한민국 수능·평가원 국어 영역 최고 전문가입니다.
제공된 기출 시험지 원문(및 이미지/해설지 참고)을 바탕으로 학생의 질문에 정확하고 명쾌하게 답하세요.

[답변 작성 원칙]
1. 반드시 제공된 시험지 지문·문제·선지 내용을 근거로 설명하세요. 추측이나 지문에 없는 내용을 지어내지 마세요.
2. 아래 구조로 알기 쉽게 정리하세요:
   - **핵심 지문 근거**: 해당 문항이 묻는 지문의 핵심 문장/문단 요점
   - **정답 선지 해설**: 정답 번호와 왜 그 선지가 지문과 정확히 일치하는지
   - **오답 선지 분석**: ${choiceFocus && choiceFocus !== '전체' ? `${choiceFocus}번 선지를 중심으로` : '주요 오답 선지(①~⑤)가'} 지문의 어떤 부분과 어긋나서 틀렸는지 구체적으로 설명
3. 학생이나 과외 선생님이 바로 수업에 쓸 수 있게 명확하고 논리적인 한국어로 작성하세요.`;

  const userMsg = `[시험 정보] ${year || ''}학년도 ${typeLabel} 국어 영역 ${qNo > 0 ? `${qNo}번 문항` : '지문 내용 전체'}
[분석 대상] ${qNo > 0 ? (choiceFocus && choiceFocus !== '전체' ? `${choiceFocus}번 선지 중심` : '전체 선지(①~⑤)') : '지문 독해 · 구조 · 핵심 개념 해설'}
[질문] ${userQuestion || (qNo > 0 ? `${qNo}번 문제의 정답 이유와 오답 선지가 틀린 이유를 지문 근거로 자세히 설명해 주세요.` : '해당 지문의 핵심 구조, 주제, 어려운 개념이나 문장 의미를 알기 쉽게 설명해 주세요.')}

${examText ? `[시험지 추출 원문]\n${String(examText).slice(0, 14000)}\n` : ''}
${answerText ? `[정답/해설지 참고]\n${String(answerText).slice(0, 4000)}\n` : ''}`;

  const parts = [{ text: sysPrompt + '\n\n' + userMsg }];
  for (const b64 of imgs) {
    if (typeof b64 === 'string' && b64.length > 100) {
      const clean = b64.replace(/^data:image\/\w+;base64,/, '');
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: clean } });
    }
  }

  const contents = [{ role: 'user', parts }];
  if (Array.isArray(chatHistory) && chatHistory.length > 0) {
    for (const turn of chatHistory.slice(-10)) {
      if (!turn || !turn.text) continue;
      contents.push({
        role: turn.role === 'model' ? 'model' : 'user',
        parts: [{ text: String(turn.text).slice(0, 4000) }]
      });
    }
    if (userQuestion) {
      contents.push({ role: 'user', parts: [{ text: String(userQuestion).slice(0, 2000) }] });
    }
  }
  const result = await callGeminiWithFallback(
    apiKey,
    { contents, generationConfig: { temperature: 0.2, maxOutputTokens: 2048 } },
    imgs.length > 0 ? 'vision' : 'chat'
  );
  if (!result || !result.text) {
    return res.status(502).json({ ok: false, error: (result && result.error) || 'AI 해설 생성에 실패했습니다.' });
  }
  res.json({ ok: true, explanation: result.text, model: result.model });
});

app.get('/api/pdf-proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const isDownload = req.query.download === '1';
  const year = String(req.query.year || '').trim();
  const type = String(req.query.type || '').trim();
  const kind = String(req.query.kind || 'q').trim();
  const useFallback = req.query.fallback === '1';
  const fileName = (req.query.name || 'essay_exam').replace(/[^a-zA-Z0-9가-힣._-]/g, '_') + '.pdf';

  const localPath = (year && type) ? getLocalKoreanPdfPath(year, type, kind) : '';
  if (localPath && fs.existsSync(localPath)) {
    try {
      const buf = fs.readFileSync(localPath);
      if (buf && buf.length > 1000) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', isDownload ? `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}` : 'inline');
        return res.send(buf);
      }
    } catch (e) {}
  }

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).send('유효한 PDF URL이 필요합니다.');
  }

  const candidateUrls = [targetUrl];
  if (useFallback && year && type) {
    try {
      const hr = await searchHoraengKoreanPdf(year, type);
      const mirror = kind === 'a' ? hr.hsj : hr.mun;
      if (mirror && !candidateUrls.includes(mirror)) candidateUrls.unshift(mirror);
      const yN = Number(year);
      if (type === '수능' && yN <= 2020) {
        const dg = `https://image.donga.com/education/exam/${year}_su/1_1.pdf`;
        if (!candidateUrls.includes(dg)) candidateUrls.push(dg);
      }
    } catch (e) {}
  }

  for (const u of candidateUrls) {
    try {
      const upstream = await fetchBinaryWithTlsBypass(u);
      if (upstream.status >= 200 && upstream.status < 400 && upstream.buffer && upstream.buffer.length > 1000) {
        if (localPath) {
          try { fs.writeFileSync(localPath, upstream.buffer); } catch (e) {}
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', isDownload ? `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}` : 'inline');
        return res.send(upstream.buffer);
      }
    } catch (err) {
      console.error('[PDF Proxy]', u, err.message);
    }
  }
  res.status(502).send('PDF 서버 연결에 실패했습니다.');
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
    ? ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-neon', 'gemini-4-argon']
    : ['gemini-3.8-flash', 'gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.5-flash'];

  const order = CACHED_MODELS[mode]
    ? [CACHED_MODELS[mode], ...preferred.filter(m => m !== CACHED_MODELS[mode])]
    : preferred;

  const errors = [];
  const tryModel = async (model) => {
    const controller = new AbortController();
    const reqTimeout = (bodyObj && bodyObj.generationConfig && bodyObj.generationConfig.maxOutputTokens >= 8192) ? 90000 : 45000;
    const timer = setTimeout(() => controller.abort(), reqTimeout);
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
    const lastErr = errors[errors.length - 1] || '';
    await new Promise(r => setTimeout(r, lastErr.includes('429') ? 2200 : 500));
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

[2025학년도 연세대학교 인문논술 공식 시험지 틀 (완전 학습 반영)]
- 상단: 우측 상단 자료집 표기 + 중앙 굵은 고딕 제목("${targetUniv} 수시모집 모의논술시험 문제 인문계열") + 우측 수험생 기입란(모집단위 | 수험번호 | 성명) + "※ 아래 제시문을 읽고 문제에 답하시오. (총 100점)"
- 제시문 영역: 외곽 실선 사각형(1단 전체 폭) 안에 제시문 (가), (나), (다), (라) 배치.
  · 제시문 (가)/(나): 철학·윤리·사회·자연과학 등 대립·보완 관점의 고밀도 학술 지문(각 800~1,100자).
  · 제시문 (다): 연세대 특유의 영어 제시문(3~4단락, 하단 * 각주 어휘 풀이 포함) 또는 비평 제시문.
  · 제시문 (라): 사회조사/실험 상황 + <표 1>, <표 2> (나란히 배치) + <그림 1> (막대/선 그래프) 포함 자료형 제시문.
- 문항 영역(하단):
  · [문제 1-1] 다면 비교·설명형 (600자 안팎, 25점)
  · [문제 1-2] [지문 A] 박스 제시문 포함 비교·평가형 (600자 안팎, 25점)
  · [문제 2-1] [가]/[나] 바탕으로 [라] 도표·그래프 분석형 (600자 안팎, 25점)
  · [문제 2-2] 확률·함수·기댓값 등 수리논술 조건 + 제시문 연결 해석형 (글자 수 제한 없음, 25점)

[대화 및 작업 원칙]
1. 유연한 대화와 학습:
   - 일반 대화·수업 상의에는 자연스럽고 명쾌한 한국어로 대화하세요.
   - 이미지나 PDF 첨부 시 문체, 논지, 출제 구조, 폰트·배치 특징을 정밀 분석해 이후 제작에 반영하세요.
2. 인문논술 문제지/모의논술 제작 요청 시:
   - 본문 답변에 [출제 의도·채점 기준·예시 답안] 요약을 작성하고, 답변 맨 마지막에 실제 시험지 틀로 렌더링할 수 있도록 반드시 아래 형식의 <EXAM_PAPER_JSON> 블록을 함께 출력하세요(일반 대화나 단순 질문일 때는 출력하지 마세요):
<EXAM_PAPER_JSON>
{
  "collectionLabel": "2027학년도 ${targetUniv} 대학별고사 자료집",
  "title": "2027학년도 ${targetUniv} 수시모집 모의논술시험 문제 인문계열",
  "totalScore": "총 100점",
  "passages": [
    { "label": "제시문 (가)", "lang": "ko", "body": "본문...", "footnote": "" },
    { "label": "제시문 (나)", "lang": "ko", "body": "본문...", "footnote": "" },
    { "label": "제시문 (다)", "lang": "en", "body": "English passage...", "footnote": "* term1: 뜻1  ** term2: 뜻2" },
    {
      "label": "제시문 (라)", "lang": "ko", "body": "조사 설명...",
      "tables": [
        { "title": "<표 1> 제목", "headers": ["구분","항목1","항목2"], "rows": [["A 그룹","20","10"],["B 그룹","10","20"]] },
        { "title": "<표 2> 제목", "headers": ["구분","변경 전","변경 후"], "rows": [["A-1","20","18"],["A-2","20","14"]] }
      ],
      "chart": { "title": "<그림 1> 제목", "yMax": 100, "labels": ["A","A-1 전","A-1 후","A-2 전","A-2 후","B"], "values": [72,72,78,72,56,50] }
    }
  ],
  "questions": [
    { "label": "[문제 1-1]", "stem": "제시문 (다)를 제시문 (가)와 제시문 (나)의 관점에서 각각 설명하시오. (600자 안팎, 25점)", "extraBoxTitle": "", "extraBoxBody": "" },
    { "label": "[문제 1-2]", "stem": "아래 [지문 A]를 읽고 제시문 (가)의 관점과 비교 설명하시오. (600자 안팎, 25점)", "extraBoxTitle": "[지문 A]", "extraBoxBody": "지문 A 본문..." },
    { "label": "[문제 2-1]", "stem": "제시문 (가)와 제시문 (나)를 바탕으로 제시문 (라)를 분석하고 설명하시오. (600자 안팎, 25점)", "extraBoxTitle": "", "extraBoxBody": "" },
    { "label": "[문제 2-2]", "stem": "수리 조건 및 제시문 연결 해석 문항... (글자 수 제한 없음, 25점)", "extraBoxTitle": "", "extraBoxBody": "" }
  ]
}
</EXAM_PAPER_JSON>` + (sourceRef ? `\n\n[사용자가 첨부한 참고 출처/원문]\n${sourceRef}` : '');

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
      let cleanReply = result.text;
      let examPaper = null;
      const jp = result.text.match(/<EXAM_PAPER_JSON>([\s\S]*?)<\/EXAM_PAPER_JSON>/i);
      if (jp && jp[1]) {
        cleanReply = result.text.replace(/<EXAM_PAPER_JSON>[\s\S]*?<\/EXAM_PAPER_JSON>/gi, '').trim();
        try {
          examPaper = JSON.parse(jp[1].trim().replace(/```json\s*/gi, '').replace(/```/g, ''));
        } catch (pe) {
          try {
            examPaper = JSON.parse(jp[1].trim().replace(/,\s*([}\]])/g, '$1'));
          } catch (pe2) {}
        }
      }
      return res.json({ ok: true, reply: cleanReply || '모의논술 시험지가 생성되었습니다.', examPaper, model: result.model });
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
const LAST_DB_HB_WRITE = {};

async function recordUserSeen(userId, forcePersist = false) {
  const uid = String(userId || '').trim();
  if (!uid || uid.startsWith('__sys_')) return;
  const now = Date.now();
  ONLINE_HEARTBEATS[uid] = now;
  const lastWrite = LAST_DB_HB_WRITE[uid] || 0;
  if (!forcePersist && (now - lastWrite) < 20000) return;
  LAST_DB_HB_WRITE[uid] = now;
  try {
    const rec = await dbGetAccount('__sys_heartbeats__');
    const map = (rec && rec.state && typeof rec.state === 'object') ? { ...rec.state } : {};
    for (const [k, v] of Object.entries(ONLINE_HEARTBEATS)) {
      if (Number(v) > Number(map[k] || 0)) map[k] = Number(v);
    }
    map[uid] = Math.max(now, Number(map[uid] || 0));
    await dbSaveAccount('__sys_heartbeats__', { name: 'SYSTEM_HEARTBEATS', pw: '', state: map });
  } catch (e) {}
}

app.post('/api/heartbeat', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { userId = '' } = req.body || {};
  if (userId) await recordUserSeen(userId, true);
  res.json({ ok: true });
});

app.get('/api/system-status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const rawUserId = String(req.query.userId || '').trim();
  const userId = rawUserId.toLowerCase();
  const loginAt = Number(req.query.loginAt || 0);
  let forceLogout = false;
  if (rawUserId) {
    await recordUserSeen(rawUserId, false);
    try {
      const loRec = await dbGetAccount('__sys_logout_epochs__');
      const loAt = Number((loRec && loRec.state && loRec.state[rawUserId]) || 0);
      forceLogout = false;
    } catch (e) {}
  }
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
    blocked: isActive && userId !== 'jace48',
    forceLogout,
    clientVersion: CLIENT_BUILD_VERSION
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
  res.setHeader('Cache-Control', 'no-store');
  const userId = String(req.query.userId || '').trim().toLowerCase();
  if (userId !== 'jace48') return res.status(403).json({ ok: false });
  const rows = await dbListAllRows();
  const hbRow = rows.find(r => r.user_id === '__sys_heartbeats__');
  const persistedHb = (hbRow && hbRow.state && typeof hbRow.state === 'object') ? hbRow.state : {};
  const now = Date.now();
  const accounts = rows
    .filter(r => !String(r.user_id || '').startsWith('__sys_') && String(r.user_id || '').toLowerCase() !== 'jace48')
    .map(r => {
      const memSeen = Math.max(ONLINE_HEARTBEATS[r.user_id] || 0, ONLINE_HEARTBEATS[String(r.user_id || '').toLowerCase()] || 0);
      const dbSeen = Math.max(Number(persistedHb[r.user_id] || 0), Number(persistedHb[String(r.user_id || '').toLowerCase()] || 0));
      const updSeen = r.updated_at ? (Date.parse(r.updated_at) || 0) : 0;
      const lastSeenAt = Math.max(memSeen, dbSeen, updSeen);
      const isOnline = lastSeenAt > 0 && (now - lastSeenAt) < 120000;
      const studentCount = (r.state && Array.isArray(r.state.students)) ? r.state.students.length : 0;
      return { userId: r.user_id, name: r.name || r.user_id, isOnline, lastSeenAt, studentCount };
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
