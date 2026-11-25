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

// 2. 호랭이닷컴에서 해당 대학·연도 논술 PDF 직링크 자동 추출
app.get('/api/horaeng-pdfs', async (req, res) => {
  const { univ = '', year = '', track = '', session = '' } = req.query;
  const searchQuery = `${univ} ${year} 논술`;
  const searchUrl = `https://horaeng.com/?s=${encodeURIComponent(searchQuery)}`;
  try {
    const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!searchRes.ok) return res.json({ ok: false, searchUrl });
    const searchHtml = await searchRes.text();

    // 게시물 링크 추출 (horaeng.com/<숫자> 또는 <제목> 형태)
    const postMatches = [...searchHtml.matchAll(/href=["'](https:\/\/horaeng\.com\/[^"']+)["']/gi)]
      .map(m => m[1])
      .filter(u => !u.includes('/category/') && !u.includes('/tag/') && !u.includes('?s=') && !u.includes('/wp-'));

    const postUrl = postMatches[0];
    if (!postUrl) return res.json({ ok: false, searchUrl });

    const postRes = await fetch(postUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!postRes.ok) return res.json({ ok: false, searchUrl, postUrl });
    const postHtml = await postRes.text();

    // PDF 링크 및 텍스트 추출
    const pdfMatches = [...postHtml.matchAll(/<a[^>]+href=["']([^"']+\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map(m => ({
        url: m[1].startsWith('http') ? m[1] : new URL(m[1], postUrl).href,
        label: m[2].replace(/<[^>]+>/g, '').trim()
      }));

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
app.get('/api/pdf-proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const isDownload = req.query.download === '1';
  const fileName = (req.query.name || 'essay_exam').replace(/[^a-zA-Z0-9가-힣._-]/g, '_') + '.pdf';

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).send('유효한 PDF URL이 필요합니다.');
  }
  try {
    const upstream = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://horaeng.com/' }
    });
    if (!upstream.ok) {
      return res.status(upstream.status).send('PDF를 불러오지 못했습니다.');
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', isDownload ? `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}` : 'inline');
    const arrayBuffer = await upstream.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
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
        !/tts|embedding|imagen|veo|lyria|audio|live|robotics/i.test(m.name || '')
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
    ? ['gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-4-carbon', 'gemini-4-neon']
    : ['gemini-4-carbon', 'gemini-4-neon', 'gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'];

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
  }

  const discovered = await discoverAvailableGeminiModels(apiKey);
  for (const model of discovered.filter(m => !order.includes(m)).slice(0, 3)) {
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
      text: `당신은 대입 인문논술 전문 선생님 보조입니다. 첨부된 제시문·해설·논제 사진과 메모("${note}")를 한 글자도 놓치지 말고 정확하게 읽은 뒤 아래 형식으로 핵심만 정리하세요.\n\n[핵심 개념어]\n- 쉼표로 구분된 주요 개념어 5~8개\n\n[제시문별 핵심 요지]\n- (가), (나), (다) 등 각 제시문의 핵심 주장과 논지\n\n[질문(논제) 요구사항]\n- 학생이 반드시 답해야 하는 조건(요약, 비교·대조, 비판·평가, 분량 등)\n\n[해설 핵심 포인트]\n- 채점 기준 및 감점 주의사항`
    }];
    [...passageImages, ...guideImages].forEach(img => {
      if (img && img.dataUrl && img.dataUrl.includes(',')) {
        parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.dataUrl.split(',')[1] } });
      }
    });
    const result = await callGeminiWithFallback(apiKey, { contents: [{ parts }] });
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
    const prompt = `당신은 대입 인문논술 과외 선생님 보조입니다. 아래 [반영된 제시문·논제 요약], [학생의 글], [선생님 첨삭]을 바탕으로 JSON만 반환하세요.\n반영된 제시문·논제의 핵심 개념과 요구사항을 학생 글이 얼마나 잘 충족했는지 강점과 약점에 구체적으로 연결해 작성하세요.\n키: strengths(문자열 배열 2~4개), weaknesses(문자열 배열 2~4개), tags(문자열 배열), actionPlan(다음 수업 처방 한두 문장).\n\n[반영된 제시문·논제 요약]\n${promptSummary || '(없음)'}\n\n[학생의 글]\n${studentText}\n\n[선생님 첨삭]\n${feedbackText}`;
    const result = await callGeminiWithFallback(apiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`학생관리 서버 실행 중: http://0.0.0.0:${PORT}`);
});
