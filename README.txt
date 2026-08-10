kwmath push 대상 파일 — 2026-08-04

■ 학생용 (1)
  surveys.html            테스트 응시·채점 화면

■ 조교용 (5)
  staff-home.html         조교 홈 (콘솔형)
  staff-students.html     학생 · 반별 일괄 출결
  staff-reports.html      리포트·테스트 확인
  staff-materials.html    수업자료
  staff-worklog.html      근무기록

■ 관리자용 (15)
  admin.html              관리자 홈 (카드 21개 · 오늘 확인할 것)
  admin-homework.html     과제 제출함
  admin-inquiries.html    상담 문의함
  admin-log.html          변경이력
  admin-makeup.html       인강 신청·해제
  admin-notify.html       알림 보내기
  admin-outcomes.html     지운 기록 (계정까지 삭제한 학생 보관 · 학생목록>졸업생 탭 아래 임베드)
  admin-qna.html          질문 관리
  admin-report.html       진단평가 보고서 (인쇄 디자인은 그대로 · 화면 UI만)
  admin-scores.html       성적 관리
  admin-seed.html         데모 데이터 채우기
  admin-staff.html        운영진 관리
  admin-stats.html        방문 통계
  admin-study.html        공부 랭킹
  admin-surveys.html      테스트·설문

총 21개. kwmath/ 폴더에 덮어쓰고 GitHub Desktop으로 push 하세요.

■ 손대지 않은 것
  staff-scores.html       /admin-scores 로 넘기는 리다이렉트
  functions/api/*.js      서버
  공유 상단 네비(.kwnav) 마크업 · 이모지

■ 되돌리는 방법
  각 파일 <style> 안 "2026-08-04 ... 콘솔 정렬" 주석으로 시작하는 블록만 지우면
  원래 디자인으로 돌아갑니다. DOM·JS·id·class는 변경하지 않았습니다.
  (예외: 이모지 → SVG 아이콘 교체, admin.html 카드에 <span class="ac-ic"> 추가)

■ 같이 보관할 문서
  디자인가이드_최종.md         학생용(portal·me) 스펙
  디자인가이드_조교관리자.md    조교·관리자 콘솔 스펙
