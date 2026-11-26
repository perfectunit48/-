#!/usr/bin/env python3
"""
대입 인문논술 아카이브 · 학생관리 SEO 상태 점검 및 IndexNow 알림 스크립트
사용법: python3 seo_check_and_ping.py
"""
import json
import urllib.request
import urllib.error

BASE_URL = "https://student-manager-0rsy.onrender.com"
ENDPOINTS = ["/", "/robots.txt", "/sitemap.xml", "/ads.txt", "/api/health"]

def check_url(path):
    url = BASE_URL + path
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 SEO-Checker/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            print(f"[OK] {path} -> HTTP {resp.status} ({len(body)} bytes)")
            return resp.status, body
    except Exception as e:
        print(f"[FAIL] {path} -> {e}")
        return 0, ""

def main():
    print("=== SEO & 서버 상태 점검 시작 ===")
    results = {p: check_url(p) for p in ENDPOINTS}
    home_status, home_html = results.get("/", (0, ""))
    if home_status == 200:
        checks = {
            "meta description": 'name="description"' in home_html,
            "canonical": 'rel="canonical"' in home_html,
            "JSON-LD": 'application/ld+json' in home_html,
            "AdSense": 'ca-pub-2857484634759539' in home_html,
        }
        for k, ok in checks.items():
            print(f"  - {k}: {'정상' if ok else '누락'}")

    # IndexNow ping (Bing/Naver 등 지원 검색엔진에 사이트 갱신 알림)
    payload = json.dumps({
        "host": "student-manager-0rsy.onrender.com",
        "urlList": [BASE_URL + "/"]
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            "https://api.indexnow.org/indexnow",
            data=payload,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            print(f"[IndexNow] 알림 전송 완료: HTTP {r.status}")
    except urllib.error.HTTPError as he:
        print(f"[IndexNow] 응답 코드: HTTP {he.code} (키 파일 미사용 시 정상)")
    except Exception as e:
        print(f"[IndexNow] 전송 건너뜀: {e}")

if __name__ == "__main__":
    main()
