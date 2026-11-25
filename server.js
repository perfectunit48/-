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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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

// 1. 중앙 DB 회원가입 / 로그인 / 상태 동기화
app.post('/api/signup', (req, res) => {
  const { userId, name, pw, state } = req.body || {};
  if (!userId || !pw) return res.status(400).json({ error: '아이디와 비밀번호가 필요합니다.' });
  const db = readDb();
  if (db.accounts[userId]) return res.status(409).json({ error: '이미 가입된 아이디입니다.' });
  db.accounts[userId] = { name: name || userId, pw, state: state || {}, updatedAt: new Date().toISOString() };
  writeDb(db);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { userId, pw } = req.body || {};
  const db = readDb();
  const acc = db.accounts[userId];
  if (!acc) return res.status(404).json({ error: '등록되지 않은 아이디입니다.' });
  if (acc.pw && acc.pw !== pw) return res.status(401).json({ error: '비밀번호가 일치하지 않습니다.' });
  res.json({ ok: true, name: acc.name, state: acc.state });
});

app.put('/api/state/:userId', (req, res) => {
  const { userId } = req.params;
  const db = readDb();
  if (!db.accounts[userId]) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  db.accounts[userId].state = req.body.state || {};
  db.accounts[userId].updatedAt = new Date().toISOString();
  writeDb(db);
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
async function callGeminiWithFallback(apiKey, bodyObj) {
  const models = ['gemini-2.5-pro', 'gemini-2.5-flash'];
  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj)
      });
      if (r.ok) {
        const data = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) return text;
      } else {
        console.error(`[Gemini ${model}] HTTP ${r.status}`);
      }
    } catch (err) {
      console.error(`[Gemini ${model}] Error:`, err.message);
    }
  }
  return '';
}

app.post('/api/reflect-photos', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const { passageImages = [], guideImages = [], note = '' } = req.body || {};
  if (!apiKey) return res.json({ ok: false });
  try {
    const parts = [{
      text: `당신은 대입 인문논술 전문 선생님 보조입니다. 첨부된 제시문·해설·논제 사진과 메모("${note}")를 빠짐없이 정확히 읽고 아래 형식으로 핵심만 정리하세요.\n\n[핵심 개념어]\n- 쉼표로 구분된 주요 개념어 5~8개\n\n[제시문별 핵심 요지]\n- (가), (나), (다) 등 각 제시문의 핵심 주장과 논지\n\n[질문(논제) 요구사항]\n- 학생이 반드시 답해야 하는 조건(요약, 비교·대조, 비판·평가, 분량 등)\n\n[해설 핵심 포인트]\n- 채점 기준 및 감점 주의사항`
    }];
    [...passageImages, ...guideImages].forEach(img => {
      if (img && img.dataUrl && img.dataUrl.includes(',')) {
        parts.push({ inline_data: { mime_type: img.mimeType || 'image/png', data: img.dataUrl.split(',')[1] } });
      }
    });
    const summary = await callGeminiWithFallback(apiKey, { contents: [{ parts }] });
    res.json({ ok: Boolean(summary), summary });
  } catch (e) {
    res.json({ ok: false });
  }
});

app.post('/api/analyze-essay', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const { studentText = '', feedbackText = '', promptSummary = '' } = req.body || {};
  if (!apiKey) return res.json({ ok: false });
  try {
    const prompt = `당신은 대입 인문논술 과외 선생님 보조입니다. 아래 [반영된 제시문·논제 요약], [학생의 글], [선생님 첨삭]을 바탕으로 JSON만 반환하세요.\n반영된 제시문·논제의 핵심 개념과 요구사항을 학생 글이 얼마나 잘 충족했는지 강점과 약점에 구체적으로 연결해 작성하세요.\n키: strengths(문자열 배열 2~4개), weaknesses(문자열 배열 2~4개), tags(문자열 배열), actionPlan(다음 수업 처방 한두 문장).\n\n[반영된 제시문·논제 요약]\n${promptSummary || '(없음)'}\n\n[학생의 글]\n${studentText}\n\n[선생님 첨삭]\n${feedbackText}`;
    const raw = await callGeminiWithFallback(apiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });
    if (!raw) return res.json({ ok: false });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.strengths) && Array.isArray(parsed.weaknesses)) {
      return res.json({ ok: true, result: parsed });
    }
    res.json({ ok: false });
  } catch (e) {
    res.json({ ok: false });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`학생관리 서버 실행 중: http://0.0.0.0:${PORT}`);
});
