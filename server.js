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
const CLIENT_BUILD_VERSION = '20261127_2355';
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
  }
};

async function checkUrlExists(url) {
  if (!url) return false;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3500);
    const r = await fetch(url, { method: 'HEAD', signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function searchEbsiKoreanPdf(year, type, kind) {
  const examLabel = type === '수능' ? '대학수학능력시험' : (type === '9월' ? '9월 모의평가' : '6월 모의평가');
  const q = kind === 'mun'
    ? `site:wdown.ebsi.co.kr "${year}학년도" "${examLabel}" 국어 문제`
    : `site:wdown.ebsi.co.kr "${year}학년도" "${examLabel}" 국어 정답`;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      signal: c.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    clearTimeout(t);
    if (!r.ok) return '';
    const html = await r.text();
    const matches = [...html.matchAll(/https?:\/\/wdown\.ebsi\.co\.kr\/[^"'\s<>]+\.pdf/gi)].map(m => m[0]);
    const execYear = Number(year) - 1;
    const mm = type === '수능' ? '11' : (type === '9월' ? '09' : '06');
    const prefix = `${execYear}${mm}`;
    const filtered = matches.filter(u => u.includes('/go3/') && u.includes('kor') && (kind === 'mun' ? (u.includes('mun') || u.includes('paper')) : (u.includes('hsj') || u.includes('answer'))));
    const exact = filtered.find(u => u.includes(prefix));
    return exact || filtered[0] || '';
  } catch (e) {
    return '';
  }
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
  '2027_9월': {
    single: { g1: '화작89/언매84', g2: '화작82/언매77', g3: '화작73/언매68' }
  },
  '2027_6월': {
    single: { g1: '화작96/언매95', g2: '화작90/언매89', g3: '화작82/언매81' }
  },
  '2025_9월': {
    single: { g1: '화작98/언매95', g2: '화작93/언매91', g3: '화작88/언매85' }
  },
  '2026_수능': {
    jongro: { g1: '화작90/언매85', g2: '화작83/언매78', g3: '화작73/언매69' }
  },
  '2026_6월': {
    single: { g1: '화작96/언매93', g2: '-', g3: '-' }
  },
  '2025_수능': {
    ebsi: { g1: '화작91', g2: '화작85', g3: '화작79' },
    megastudy: { g1: '화작91~92', g2: '화작83~84', g3: '-' },
    mimac: { g1: '화작92', g2: '화작84~85', g3: '-' },
    jongro: { g1: '화작95/언매92', g2: '화작88/언매86', g3: '화작79/언매77' }
  },
  '2026_9월': {
    single: { g1: '화작92/언매86', g2: '화작87/언매81', g3: '화작78/언매73' }
  },
  '2024_수능': {
    jongro: { g1: '88', g2: '81', g3: '72' }
  },
  '2023_수능': {
    ebsi: { g1: '화작96', g2: '화작92', g3: '화작86' }
  }
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
  const isMock = (type === '6월' || type === '9월');
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
    if (typeof KOREAN_PARSED_ANSWERS_CACHE !== 'undefined' && KOREAN_PARSED_ANSWERS_CACHE[cacheKey]) cachedP.cachedAnswers = KOREAN_PARSED_ANSWERS_CACHE[cacheKey];
    return res.json(cachedP);
  }
  const mm = type === '수능' ? '11' : (type === '9월' ? '09' : '06');
  const execYear = yNum - 1;
  const preset = KOREAN_EXAM_PRESETS[cacheKey] || {};

  let questionPdfUrl = preset.questionPdfUrl || '';
  let answerPdfUrl = preset.answerPdfUrl || '';

  const ttProb = `https://cdn.teamturing.com/cms/webflow/sat_pdf/03/${execYear}/03-${mm}-01-p-01.pdf`;
  const ttAns = `https://cdn.teamturing.com/cms/webflow/sat_pdf/03/${execYear}/03-${mm}-01-s-01.pdf`;

  const checks = await Promise.all([
    !questionPdfUrl ? checkUrlExists(ttProb) : Promise.resolve(false),
    !answerPdfUrl ? checkUrlExists(ttAns) : Promise.resolve(false)
  ]);
  if (!questionPdfUrl && checks[0]) questionPdfUrl = ttProb;
  if (!answerPdfUrl && checks[1]) answerPdfUrl = ttAns;

  const fallbacks = await Promise.all([
    !questionPdfUrl ? searchEbsiKoreanPdf(year, type, 'mun') : Promise.resolve(''),
    !answerPdfUrl ? searchEbsiKoreanPdf(year, type, 'hsj') : Promise.resolve('')
  ]);
  if (!questionPdfUrl && fallbacks[0]) questionPdfUrl = fallbacks[0];
  if (!answerPdfUrl && fallbacks[1]) answerPdfUrl = fallbacks[1];

  const payload = {
    ok: true,
    year,
    type,
    questionPdfUrl,
    answerPdfUrl,
    cachedAnswers: (typeof KOREAN_PARSED_ANSWERS_CACHE !== 'undefined' && KOREAN_PARSED_ANSWERS_CACHE[cacheKey]) || null,
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
app.post('/api/korean-parse-answers', async (req, res) => {
  const _reqKey = req.body && req.body.year && req.body.type ? `${req.body.year}_${req.body.type}` : '';
  if (_reqKey && KOREAN_PARSED_ANSWERS_CACHE[_reqKey]) return res.json(KOREAN_PARSED_ANSWERS_CACHE[_reqKey]);
  res.setHeader('Cache-Control', 'no-store');
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'GEMINI_API_KEY 미설정' });
  }
  const { year, type, answerText, pageImageBase64 } = req.body || {};
  const yNum = Number(year || 2026);
  const isElective = yNum >= 2022;
  const typeLabel = type === '수능' ? '대학수학능력시험(수능)' : `${type || ''} 학력평가`;

  const prompt = isElective
    ? `다음은 ${yNum}학년도 ${typeLabel} 국어 영역 공식 정답표/해설지 자료입니다.
제공된 이미지 또는 텍스트에서 실제로 확인되는 공식 정답만 정확히 추출해 원문자(①,②,③,④,⑤) JSON으로 출력하세요.
[절대 규칙]
- 자료에 명시되지 않은 번호나 과목(예: 언어와 매체가 자료에 없는 경우)은 절대 추측하거나 임의의 번호(예: 전부 ①)로 채우지 말고 빈 객체 {}로 두세요.
- 화법과 작문 답을 언어와 매체에 복사하지 마세요.
JSON 형식만 출력:
{"common":{"1":"①"},"hwajak":{"35":"④"},"eonmae":{"35":"②"}}

[정답/해설지 텍스트]
${String(answerText || '').slice(0, 14000)}`
    : `다음은 ${yNum}학년도 ${typeLabel} 국어 영역 공식 정답표/해설지 자료입니다.
자료에서 실제로 확인되는 1~45번 공식 정답만 원문자(①,②,③,④,⑤) JSON으로 출력하세요. 확인되지 않는 문항은 비워두세요.
JSON 형식만 출력:
{"common":{"1":"①"}}

[정답/해설지 텍스트]
${String(answerText || '').slice(0, 14000)}`;

  const parts = [{ text: prompt }];
  if (typeof pageImageBase64 === 'string' && pageImageBase64.length > 100) {
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: pageImageBase64.replace(/^data:image\/\w+;base64,/, '') } });
  }

  const result = await callGeminiWithFallback(
    apiKey,
    { contents: [{ parts }], generationConfig: { temperature: 0.0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } } },
    pageImageBase64 ? 'vision' : 'chat'
  );
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
    const sanity = (m) => {
      const vals = Object.values(m);
      if (vals.length >= 6 && new Set(vals).size <= 1) return {};
      let run = 1;
      for (let i = 1; i < vals.length; i++) {
        run = (vals[i] === vals[i - 1]) ? run + 1 : 1;
        if (run >= 7) return {};
      }
      return m;
    };
    res.json({
      ok: true,
      commonMap: sanity(norm(parsed.common)),
      hwajakMap: sanity(norm(parsed.hwajak)),
      eonmaeMap: sanity(norm(parsed.eonmae))
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: '정답 JSON 파싱 실패' });
  }
});


app.post('/api/korean-mock-generate', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'GEMINI_API_KEY가 설정되어 있지 않습니다.' });
  }
  const { title = 'AI 자체제작 모의고사 1회', elective = '화법과 작문', userPrompt = '', userId = '', stream = false } = req.body || {};
  if (String(userId || '').trim().toLowerCase() !== 'jace48') {
    return res.status(403).json({ ok: false, error: 'AI 모의고사 자체제작은 jace48 계정에서만 이용할 수 있습니다.' });
  }

  const sendEvent = (obj) => {
    if (stream && !res.writableEnded) {
      res.write(JSON.stringify(obj) + '\n');
    }
  };
  if (stream) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    sendEvent({ type: 'progress', pct: 10, msg: '17~27학년도 기출 난이도·출제 틀 분석 중...' });
  }

  const commonPolicy = `당신은 한국교육과정평가원(KICE) 수능 국어 영역 출제위원입니다.
2017~2027학년도 수능·6월·9월 모의평가의 출제 기조, 실제 수능 지문 분량과 밀도, 선지 함정 패턴(인과 역전, 범위 확대/축소, 개념 뒤바꾸기, <보기> 적용)을 정밀하게 반영해 출제하세요.
목표 난이도는 1등급 컷 원점수 80점대 중반~90점대 초반(변별력 있는 중상~상 난이도, [3점] 추론·적용 문항 포함)입니다.
[분량 및 문항 수 필수 조건]
- 독서 지문은 실제 평가원 기출처럼 충분히 길고 깊이 있게 작성하세요([1~3] 700자 이상, [4~9] (가)/(나) 합산 2,000자 이상, [10~13]·[14~17] 각 1,500자 이상).
- <보 기> 문항은 실제 수능처럼 구체적 사례·자료·비평을 180~320자 분량으로 충실히 작성하세요.
- 모든 문항의 stem 앞에는 반드시 문항 번호("1. ", "2. " ... "45. ")를 붙이고, 지정된 범위의 모든 번호를 1문항도 빠짐없이 출제하세요.
[출제 자체 검토 기준]
1. 모든 문항의 정답 선지는 지문·<보기>의 근거와 100% 논리적으로 일치해야 합니다.
2. 나머지 4개 오답 선지는 지문 내용과 어긋나는 명확한 오답 근거를 갖추어야 하며 복수 정답이 없어야 합니다.
[추가 요청사항]
${userPrompt || '평가원 기출 스타일에 맞춰 균형 있게 출제'}

반드시 아래 순수 JSON 형식만 출력하세요:
{"passages":[{"range":"[1~3]","header":"[1~3] 다음 글을 읽고 물음에 답하시오.","body":"지문 본문(문단 구분은 \n\n, ㉠~㉤ 포함)","questions":[{"no":1,"stem":"1. 발문","box":"<보 기> 내용 없으면 빈 문자열","points":2,"choices":["① 선지1","② 선지2","③ 선지3","④ 선지4","⑤ 선지5"],"answer":"③","explain":"정답 및 오답 핵심 근거 1~2줄"}]}]}`;

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
  const callPart = async (partDesc) => {
    const prompt = `${commonPolicy}\n\n[이번에 출제할 파트]\n${partDesc}`;
    const configs = [
      { temperature: 0.5, maxOutputTokens: 8192, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      { temperature: 0.5, maxOutputTokens: 8192, responseMimeType: 'application/json' },
      { temperature: 0.45, maxOutputTokens: 8192 }
    ];
    for (const genCfg of configs) {
      const r = await callGeminiWithFallback(
        apiKey,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: genCfg },
        'chat'
      );
      if (r && r.text) {
        const list = safeParsePassages(r.text);
        if (list.length > 0) return list;
        partErrors.push('JSON 파싱 실패');
      } else if (r && r.error) {
        partErrors.push(r.error);
      }
    }
    return [];
  };

  try {
    // 2 waves (Wave 1: Reading 1~17 + Elective 35~45; Wave 2: Literature 18~34) -> fast (<1 min) and safe from 429
    sendEvent({ type: 'progress', pct: 25, msg: `독서(1~17번) 및 ${elective}(35~45번) 출제 중...` });
    const [p1, p3] = await Promise.all([
      callPart('공통과목 독서 1~17번(총 17문항): [1~3] 독서 이론(3문항), [4~9] 인문·사회 (가)/(나)(6문항), [10~13] 과학·기술(4문항), [14~17] 법·경제(4문항). 1번부터 17번까지 빠짐없이 출제하세요.'),
      callPart(`선택과목 '${elective}' 35~45번(총 11문항): 평가원 ${elective} 실제 구성에 맞춰 35번부터 45번까지 빠짐없이 출제하세요.`)
    ]);
    sendEvent({ type: 'progress', pct: 65, msg: '독서·선택 완료! 문학(18~34번) 출제 및 검토 중...' });
    await new Promise(r => setTimeout(r, 400));
    const p2 = await callPart('공통과목 문학 18~34번(총 17문항): [18~21] 현대소설(4문항), [22~27] 갈래 복합(6문항), [28~31] 고전소설(4문항), [32~34] 현대시 (가)/(나)(3문항). 18번부터 34번까지 빠짐없이 출제하세요.');
    sendEvent({ type: 'progress', pct: 95, msg: '45문항 시험지 및 PDF 조판 정리 중...' });

    const passages = [...p1, ...p2, ...p3].map(p => {
      const qs = Array.isArray(p.questions) ? p.questions.map(q => {
        const no = Number(q.no || 0);
        let stem = String(q.stem || '').trim();
        if (no > 0 && !new RegExp('^' + no + '\\s*[\\.\\)]').test(stem)) {
          stem = `${no}. ${stem}`;
        }
        return Object.assign({}, q, { no, stem });
      }).sort((a, b) => a.no - b.no) : [];
      return Object.assign({}, p, { questions: qs });
    }).sort((a, b) => ((a.questions[0] && a.questions[0].no) || 99) - ((b.questions[0] && b.questions[0].no) || 99));
    if (passages.length === 0) {
      const detail = [...new Set(partErrors)].slice(0, 3).join(' / ');
      const errObj = { ok: false, error: `모의고사 생성에 실패했습니다. (${detail || 'AI 응답 파싱 오류'}) 다시 시도해 주세요.` };
      if (stream) { sendEvent(Object.assign({ type: 'error' }, errObj)); return res.end(); }
      return res.status(502).json(errObj);
    }
    const doneObj = { ok: true, title, elective, passages };
    if (stream) { sendEvent(Object.assign({ type: 'done' }, doneObj)); return res.end(); }
    res.json(doneObj);
  } catch (e) {
    const errObj = { ok: false, error: '모의고사 생성 중 오류가 발생했습니다: ' + (e.message || '') };
    if (stream) { sendEvent(Object.assign({ type: 'error' }, errObj)); return res.end(); }
    res.status(500).json(errObj);
  }
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
