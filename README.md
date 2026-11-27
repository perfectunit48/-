# 과외생 관리 · 대입 인문논술 & 수능 국어 과외 통합 관리 플랫폼

- **공식 웹 서비스**: [https://student-manager-0rsy.onrender.com/](https://student-manager-0rsy.onrender.com/)
- **사이트맵**: [sitemap.xml](https://student-manager-0rsy.onrender.com/sitemap.xml)
- **AI/검색 안내 문서**: [llms.txt](https://student-manager-0rsy.onrender.com/llms.txt)

---

## 1. 첫 화면 (비로그인 공개 페이지)
- **과목 전환 (`인문논술` | `국어`)**: 상단 버튼을 눌러 인문논술 가이드와 국어 영역 안내를 바로 전환할 수 있습니다.
- **인문논술 모드**: 주요 12개 대학(연·고·서·성·한·중·경·외·건·동·홍·숙) 출제 경향, 시험 시간·문항 비교표, **2026학년도 선행학습 영향평가 보고서 PDF 미리보기** 제공.
- **국어 모드**: **2027학년도 국어 기출(6월 학력평가 · 9월 학력평가 · 수능)** PDF 미리보기 제공.
- **이용안내 · 문의 및 안내**: 하단 푸터 모달로 서비스 안내 및 문의 경로 제공.

---

## 2. 과목별 맞춤 관리 기능 (선생님 로그인 후)

### A. 인문논술 학생 선택 시
- **첨삭 & 분석**: 제시문·해설 스크린샷 요약(`사진 반영하기`), 학생 글 및 선생님 첨삭 분석, 약점 태그 관리.
- **누적 글 데이터**: 회차별 누적 글 목록 및 자동 줄글 성장 요약.
- **논술 기출 (2021~2026학년도)**: 주요 12개 대학 연도별 선행학습 영향평가 보고서 PDF 미리보기 및 2027 수시 모집요강 안내.

### B. 국어 학생 선택 시 (`첨삭 & 분석` 자동 숨김)
- **성적 데이터**:
  - **점수 입력 ↔ 개수 입력** 전환 지원 (공통·선택·전체 점수 또는 맞힌 문항 수 `/34`, `/11`, `/45`).
  - **표준점수 · 백분위** 및 **독서 · 문학 · 선택 영역별 맞힌 개수** 기록, 강점·약점 입력.
  - **고화질(HiDPI) 성적 추이 그래프 & PNG 이미지 저장**: 날짜순 정렬 그래프, 점에 마우스를 올리면 백분위·표준점수·직전 대비 변화율 툴팁 표시.
  - **자동 성장 요약 & 학부모 문자 연동**: 조사(`이/가`, `을/를`)와 날짜순 변화를 반영한 성장 요약 생성 및 `학부모 문자에 올리기` 지원.
- **국어 기출 (2017~2027학년도)**:
  - `6월 학력평가`, `9월 학력평가`, `수능` 문제지 PDF 전체 페이지 미리보기.
  - **분리 정답표**: 2022~2027학년도는 공통(1~34번) + 화법과 작문(35~45번) + 언어와 매체(35~45번) 분리 표시 (PDF 파싱 + Gemini 자동 보완).
  - **Gemini 문항 · 지문 AI 해설**: `문항 질문`(문항 번호 + 선지별 분석)과 `지문 질문`(`[공통]` / `[화법과 작문]` / `[언어와 매체]` 제시문 목록 선택) 스위치 제공. 텍스트 추출 및 스캔 PDF 이미지 인식 모두 지원.

### C. 공통 관리 · 시스템 기능
- **진도 관리 & 출결 관리**: 단원별 체크리스트 진행률, 수업 출결 기록 및 출석률 자동 계산.
- **학부모 문자**: 저장된 커스텀 양식에 과목별 최근 기록·강점·약점·성장 요약·진도·출결 자동 채우기.
- **15초 자동 저장 & 상단 수동 저장**: 작성 중인 글·첨부 이미지·학생 데이터를 15초 간격으로 로컬 및 서버에 자동 저장.
- **보안 & 세션 관리**: 처음 접속 시 항상 로그아웃 상태에서 시작하며, 로그인 중에는 탭·창을 벗어나도 유지됩니다. `로그아웃` 시 동일 아이디로 로그인된 모든 기기·탭에서 동시 로그아웃되며 재로그인 전까지 자동 로그인되지 않습니다.
- **무캐시 자동 갱신 & PWA**: 첫 화면 및 서비스 워커(`sw.js`) 캐시를 차단하고 `clientVersion` 불일치 시 자동 캐시 우회 리로드로 PC·모바일·태블릿에서 강력 새로고침 없이 최신 버전을 반영합니다.

---

## 3. 주요 12개 대학 2026학년도 보고서 바로가기
- [연세대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=yonsei)
- [고려대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=korea)
- [서강대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=sogang)
- [성균관대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=skku)
- [한양대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=hanyang)
- [중앙대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=cau)
- [경희대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=khu)
- [한국외국어대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=hufs)
- [건국대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=konkuk)
- [동국대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=dongguk)
- [홍익대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=hongik)
- [숙명여자대학교 2026 인문논술 기출](https://student-manager-0rsy.onrender.com/?univ=sookmyung)

---

## 4. 배포 및 파일 구조
```text
.
├── server.js          # Express 서버, Supabase 연동, Gemini API, PDF 프록시, SEO/캐시 제어
├── package.json       # Node >= 18, express, cors
├── README.md          # 프로젝트 안내 문서
└── public/
    ├── index.html     # 전체 프론트엔드 UI 및 PDF.js / PWA 클라이언트
    ├── sw.js          # 네트워크 우선 서비스 워커
    ├── icon-192.png   # PWA 아이콘 (192x192)
    └── icon-512.png   # PWA 아이콘 (512x512)
```

### Render 환경 변수 설정
- `GEMINI_API_KEY`: Gemini 첨삭 요약, 국어 기출 문항·지문 AI 해설, 선택과목 정답 보완, 건의사항 필터링
- `SUPABASE_URL`, `SUPABASE_KEY`: 계정·학생 데이터·공지사항·로그아웃 상태 영구 저장
