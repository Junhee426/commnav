# Render 배포 안내

이 패키지는 K-LEO 통신·항법 통합 시뮬레이터의 전체 소스입니다. 계산과 CSV 생성은 브라우저에서 실행되며, Render **Static Site**로 배포할 수 있습니다. 백엔드·데이터베이스·API 키가 필요하지 않습니다.

## 1. GitHub에 소스 올리기

1. `kleo-comm-nav-render.zip`의 압축을 풉니다.
2. GitHub에서 새 저장소를 만듭니다. 비공개 저장소도 사용할 수 있으며, Render에 해당 저장소 접근 권한을 연결해야 합니다.
3. 압축을 풀어 나온 `kleo-comm-nav-render` 폴더의 **내용물**을 저장소 최상위에 올립니다. ZIP 파일 자체를 올리는 방식이 아닙니다.
4. 저장소 첫 화면에 `render.yaml`, `package.json`, `README.md`와 `dist`, `scripts`, `tests` 폴더가 함께 보이는지 확인합니다. `dist`에는 지구 영상인 `earth.jpg`도 포함되어야 합니다.

## 2. Blueprint로 배포하기

1. [Render 대시보드](https://dashboard.render.com/)에서 **New → Blueprint**를 선택합니다.
2. 위 GitHub 저장소를 연결하고 배포할 브랜치를 선택합니다.
3. Blueprint 파일 경로는 기본값인 `render.yaml`을 사용합니다.
4. 생성할 Static Site 이름과 설정을 확인하고 배포를 시작합니다. 같은 이름의 서비스가 이미 있다면 `render.yaml`의 `name`을 원하는 새 이름으로 바꿉니다.
5. 배포가 완료되면 Render가 제공하는 `https://…onrender.com` 주소를 엽니다.

`render.yaml`에는 정적 사이트 유형, 빌드 명령, 공개 폴더와 의존 패키지 자동 설치를 생략하는 설정이 포함되어 있습니다. 해시 없는 파일명의 갱신을 반영하도록 브라우저 캐시 재검증 헤더도 지정합니다.

## 직접 설정하려면: New → Static Site

Blueprint 대신 Static Site 생성 화면에서 다음 값을 입력할 수도 있습니다. 이 경우 `render.yaml`이 자동 적용되는 것으로 가정하지 말고 아래 값을 직접 설정합니다.

| 항목 | 입력값 |
| --- | --- |
| Name | `kleo-comm-nav` 또는 원하는 이름 |
| Branch | 소스를 올린 브랜치, 보통 `main` |
| Root Directory | 비워 두기: 위 1단계처럼 저장소 최상위에 올린 경우 |
| Build Command | `npm run build` |
| Publish Directory | `dist` |
| Environment Variable | `SKIP_INSTALL_DEPS` = `true` |
| Start Command | Static Site에서는 사용하지 않음 |

Node.js 버전 범위는 `package.json`의 `engines`에 `>=24 <25`로 지정되어 있습니다. 별도 Node 버전 환경변수를 입력할 필요가 없습니다. Redirect/Rewrite 규칙도 추가할 필요가 없습니다.

Static Site의 Headers 설정에 Path `/*`, Name `Cache-Control`, Value `public, max-age=0, must-revalidate`를 추가하면 Blueprint와 같은 캐시 설정이 됩니다.

## 배포 후 확인

1. 첫 화면의 지구와 위성 표시가 나타나는지 확인합니다.
2. 관측지 또는 위성 수를 바꾸고 24시간 분석을 실행해 결과가 갱신되는지 확인합니다.
3. CSV를 내려받아 분석 시점의 설정과 표본 결과가 포함되는지 확인합니다.

이 설정으로 배포한 사이트는 별도 로그인 없이 접근하는 공개 웹사이트입니다. 기존 ChatGPT 사이트의 접근 제한은 이전되지 않습니다. GitHub 저장소의 공개 여부와 웹사이트 공개 여부는 별개입니다.

## 수정과 로컬 실행

`dist/` 파일이 수정할 원본입니다. 수정한 소스를 연결된 배포 브랜치에 푸시하면 Render의 자동 배포 설정에 따라 갱신됩니다. 빌드 전 검사는 Node.js 24에서 다음 명령으로 실행합니다.

```bash
npm run build
```

별도 `npm install`은 필요하지 않습니다. 로컬에서 화면을 열려면 Python 3로 정적 HTTP 서버를 실행하고 `http://localhost:8000`으로 접속합니다.

```bash
python3 -m http.server 8000 --directory dist
```

HTML 파일을 더블클릭하는 `file://` 실행은 ES 모듈과 Web Worker를 정상적으로 제공하지 못하므로 사용하지 않습니다. 계산 가정과 검증 범위는 [README](README.md)를 참고하십시오.

## 배포 오류를 확인할 때

| 증상 | 확인할 설정 |
| --- | --- |
| `package.json` 또는 `scripts/verify-static.mjs`를 찾지 못함 | ZIP 안의 전체 소스가 올라갔는지, Root Directory가 맞는지 확인 |
| 배포 후 첫 화면이 404 | Publish Directory가 `dist`인지 확인 |
| 지구 영상 또는 24시간 분석이 로드되지 않음 | `earth.jpg`, `analysis-worker.js`, `engine.js`가 포함되었는지 확인 |
| JavaScript 대신 HTML이 반환됨 | 모든 경로를 `index.html`로 보내는 Rewrite 규칙이 있다면 제거 |

## 공식 참고자료

- [Render Static Sites: 생성 절차와 의존 패키지 설정](https://render.com/docs/static-sites)
- [Render Blueprints: 생성과 관리](https://render.com/docs/infrastructure-as-code)
- [Render Blueprint Specification: render.yaml 필드](https://render.com/docs/blueprint-spec)
- [Render Node.js 버전 지정](https://render.com/docs/node-version)

배포 안내 확인일: 2026-09-11. 이 패키지는 배포 준비용이며 사용자의 Render 계정에 실제 배포를 수행한 결과물은 아닙니다.
