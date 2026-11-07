# 表單限額管理平台（Railway 版）

多組織版本：你是**平台管理員**，替每個組織開帳號。組織把一個**指定名稱的資料夾**共用給你，把表單放進去，平台就會直接控管裡面的表單。

- **不佔你的雲端硬碟**：平台不複製、不建立任何檔案。表單、回覆、上傳的檔案都留在組織自己的帳號
- 名額上限、開放時間、截止時間：每分鐘自動檢查，到了就開關表單
- **依送出順序排位**：超出名額的人自動收到「候補」信；之後有人被刪除、候補排進名額內，再寄「遞補成功」信
- 每個組織只看得到自己的資料夾、表單、帳號和紀錄
- 部署新版時有 **30 秒緩衝**，舊版會把正在做的檢查和寄信做完、把資料寫回磁碟才關閉
- 零套件依賴：Node.js 22.13 以上，資料庫用 Node 內建的 SQLite

```
railway/
  server.js          進入點
  lib/app.js         API 與權限
  lib/google.js      Google OAuth、Drive、Forms API
  lib/limiter.js     規則判斷、排位、寄通知、每分鐘排程
  lib/mailer.js      寄信（SMTP 或 Resend）
  lib/db.js          SQLite 資料表
  lib/security.js    密碼雜湊、加密
  public/index.html  網頁介面
  test/              測試（模擬 Google API）
```

---

## 一、Google Cloud 設定（約 10 分鐘，只做一次）

用**平台的 Google 帳號**操作，也就是組織要共用資料夾給它的那個帳號，例如 chase5ws@gmail.com。

1. 到 <https://console.cloud.google.com/projectcreate> 建立新專案，例如「form-limiter」。
2. 啟用兩個 API：
   - <https://console.cloud.google.com/apis/library/forms.googleapis.com> →「啟用」
   - <https://console.cloud.google.com/apis/library/drive.googleapis.com> →「啟用」
3. 設定 OAuth 同意畫面：<https://console.cloud.google.com/auth/overview>
   - 「品牌」：填應用程式名稱（例如「表單限額管理平台」）和支援 Email。
   - 「目標對象」：選 **外部**。
   - **按「發布應用程式」，改成「實際運作中」**。如果停在「測試中」，Google 授權每 7 天就會失效。不用送審，只有你自己的帳號會登入。
4. 建立 OAuth 用戶端：<https://console.cloud.google.com/auth/clients> →「建立用戶端」
   - 應用程式類型：**網頁應用程式**
   - 已授權的重新導向 URI：`https://你的網域/oauth/google/callback`，網域在第二部分第 3 步取得，可以先空著，回來再填。
   - 建立後複製 **用戶端 ID** 和 **用戶端密鑰**。

## 二、Railway 部署

1. Railway → New Project → **Deploy from GitHub repo** → 選 `chase5ws/2026_google_form_limiter`。
2. 服務的 **Settings**：
   - Source → **Root Directory** 填 `/railway`
   - Config-as-code → **Railway Config File** 填 `/railway/railway.json`
3. **Settings → Networking → Generate Domain**，會拿到 `xxxx.up.railway.app`。把 `https://xxxx.up.railway.app/oauth/google/callback` 填回第一部分第 4 步的重新導向 URI。
4. **新增 Volume**：在服務上按右鍵 → Attach Volume，掛載路徑填 `/data`。
   > 沒掛 Volume 的話，每次部署所有資料都會消失。
5. **Variables** 加入：

   | 變數 | 值 |
   |---|---|
   | `DATA_DIR` | `/data` |
   | `GOOGLE_CLIENT_ID` | 第一部分複製的用戶端 ID |
   | `GOOGLE_CLIENT_SECRET` | 用戶端密鑰 |
   | `ENCRYPTION_KEY` | 隨機長字串，在終端機執行 `openssl rand -base64 32` 產生。用來加密存放 Google 授權，**設定後不要改**，改了要重新連接 Google |
   | `APP_URL` | 選填。預設會用 Railway 網域；綁自訂網域時才要填，例如 `https://forms.example.com` |
   | `CHECK_INTERVAL_SECONDS` | 選填，預設 `60` |
   | `DRIVE_FOLDER_NAME` | 選填，組織共用資料夾必須取的名稱，預設 `表單限額平台`。也可以之後在「平台設定」改 |
   | **寄信（二選一）** | |
   | `RESEND_API_KEY` + `MAIL_FROM` | **Hobby 方案用這個。** 到 <https://resend.com> 註冊、驗證你的網域，拿 API Key。`MAIL_FROM` 例如 `表單平台 <noreply@你的網域>` |
   | `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `MAIL_FROM` | **只有 Railway Pro 以上能用**。例如 Gmail：`smtp.gmail.com`、`465`、你的 Gmail、[應用程式密碼](https://myaccount.google.com/apppasswords) |

6. 部署完成後打開網域，就能看到登入頁。

**之後每次 push 到 `main`，只要改到 `railway/` 底下的檔案，Railway 就會自動重新部署。** 資料存在 Volume，不受部署影響。

### 部署緩衝（30 秒）
`railway.json` 已設定 `drainingSeconds: 30`：部署新版時，舊版先收到 SIGTERM，30 秒後才會被強制關閉。這段時間舊版會：
1. 不再接受新的請求（回應「系統正在更新，請 30 秒後再試」）
2. 等目前的表單檢查、寄信做完
3. 把 SQLite 的 WAL 寫回主檔，再關閉

如果 Railway 後台的 Settings → Deploy 有另外設定 Draining Seconds，以後台為準，記得也設成 30。

## 三、開始使用

### 平台管理員（你）
1. 用預設帳號 **`chase5ws` / `chase5ws`** 登入，系統會要求你立刻改密碼。
2. **平台設定 → 連接 Google** → 用平台的 Google 帳號登入。
   - 會看到「Google 尚未驗證這個應用程式」，點「進階 → 前往（不安全）」→ 允許。
   - 在同一頁確認「組織共用資料夾名稱」，預設是「表單限額平台」，可以改成你要的名稱。
   - 設好寄信的環境變數後，在「寄信」區塊寄一封測試信確認。
3. **所有組織 → 建立組織**：填組織名稱和第一位組織管理員。帳密會自動複製到剪貼簿，私訊給對方。
4. 上方「管理組織」下拉選單可以切換到任一組織，替他們處理表單或帳號。

### 組織管理員
1. 用你給的帳密登入，改成自己的密碼。
2. 在自己的 Google 雲端硬碟**建立資料夾，名稱必須是「表單限額平台」**（或你在平台設定改的名稱）。
3. 對資料夾按右鍵 →「共用」，把平台的 Gmail 加為**編輯者**。畫面上會顯示要加哪個 Gmail。
4. 平台「表單」分頁 → 貼上資料夾連結 →「連結資料夾」。這個步驟只要做一次。
5. 在資料夾裡建立表單，或把現有表單移進來，回平台按「重新整理」，再按「加入管理」。
6. 設定名額、開放和截止時間。需要的話，勾選「名額已滿時寄信通知」。
7. 填寫連結**不變**，照常發給大家就好。
8. 「帳號」分頁可以新增同事。組織成員能管理表單，但不能設定資料夾和帳號。

### 名額已滿通知怎麼運作
- 每分鐘讀一次回覆，依**送出時間**排位。第 1 到 N 名是正取，N+1 名之後是候補。
- 候補的人會收到「候補」信，例如「您的報名順位是第 32 位（候補第 2 位）」。
- 管理員在 Google 表單刪掉某筆回覆後，排位會重算。原本候補、現在排進名額內的人，會收到「遞補成功」信。
- 每人每種信只寄一次。寄失敗會重試，最多 3 次。卡片上的「寄信紀錄」可以看到每一封信的狀態。
- 收件 Email 有兩種來源：
  - 表單開啟「收集電子郵件地址」（表單設定 → 回覆）
  - 另外指定一題讓填寫者輸入 Email 的簡答題
- 信件主旨和內容可以自訂，能用 `{title}` `{org}` `{rank}` `{limit}` `{waitlist}` 這幾個變數。

## 雲端硬碟與容量

- 平台**不會**在你的雲端硬碟建立任何檔案。表單由組織擁有，容量算在組織身上。
- 平台的 Google 權限只有三項：
  - 讀取雲端硬碟的**檔案清單**（`drive.metadata.readonly`），用來列出資料夾裡的表單
  - **開關表單**（`forms.body`）
  - **讀取回覆**（`forms.responses.readonly`），用來計算份數和排位
- 組織只能加入**放在自己共用資料夾裡**的表單，其他地方的表單會被拒絕。
- 組織把資料夾的共用取消後，該組織的表單卡片會顯示錯誤，表單會停在最後的狀態。

## 安全設計

- 密碼用 scrypt 雜湊，Google 授權用 AES-256-GCM 加密後存放。
- Session 存在 HttpOnly Cookie，12 小時沒有動作就失效。改密碼、被停用或被重設密碼時，舊的登入會立即失效。
- 寫入類 API 都要帶自訂標頭，用來防 CSRF。同一帳號連續登入失敗 5 次，會鎖 15 分鐘。
- 組織之間完全隔離：每個 API 都會檢查目前使用者屬於哪個組織。

## 限制

- 每分鐘檢查一次，人很多時可能會多收幾份。Google 表單本身沒有硬上限。
- 所有 API 都用你一個 Google 帳號呼叫，同時管理的表單大約到 100–150 份時會碰到 Forms API 的每分鐘配額。表單更多的話，把 `CHECK_INTERVAL_SECONDS` 調高，例如 `120`。
- 每次檢查最多寄 30 封信，其餘的下一分鐘繼續寄。
- Forms API 不能改「表單已關閉」時的提示文字，會顯示 Google 預設的訊息。
- 2025 年以前建立的**舊版表單**不能用 API 開關。請在 Google 表單按「⋮ → 建立副本」，副本是新版格式。
- Railway Free、Trial、Hobby 方案**封鎖 SMTP**，請改用 Resend。
- SQLite 只能跑 1 個實例。`railway.json` 已經設好 `numReplicas: 1`。

## 本機開發與測試

```bash
cd railway
npm start                                   # http://localhost:3000，資料存在 ./data
npm test                                    # API、SMTP、優雅關閉測試（模擬 Google）
node test/ui.run.js ./test/shots            # 介面測試（需要 Playwright）
```
