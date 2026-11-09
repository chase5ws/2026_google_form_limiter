# 表單限額管理平台

多組織版本：你是**平台管理員**，替每個組織開帳號。組織把一個**指定名稱的資料夾**共用給你，把表單放進去，平台就會直接控管裡面的表單。

- **不佔你的雲端硬碟**：平台不複製、不建立任何檔案。表單、回覆、上傳的檔案都留在組織自己的帳號
- 名額上限、開放時間、截止時間：每分鐘自動檢查，到了就開關表單
- **依送出順序排位**：超出名額的人自動收到「候補」信；之後有人被刪除、候補排進名額內，再寄「遞補成功」信
- 每個組織只看得到自己的資料夾、表單、帳號和紀錄
- 部署新版時有 **30 秒緩衝**，舊版會把正在做的檢查和寄信做完、把資料寫回磁碟才關閉
- 零套件依賴：Node.js 22.13 以上，資料庫用 Node 內建的 SQLite

```
server.js            進入點
lib/app.js           API 與權限
lib/google.js        Google OAuth、Drive、Forms API
lib/limiter.js       規則判斷、排位、寄通知、每分鐘排程
lib/mailer.js        寄信（SMTP 或 Resend）
lib/db.js            SQLite 資料表
lib/security.js      密碼雜湊、加密
lib/runtime.js       自動偵測 Volume、產生金鑰、網頁上的設定
public/index.html    網頁介面
railway.json         Railway 設定（啟動指令、健康檢查、30 秒緩衝）
test/platform/       平台測試（模擬 Google API）
```

---

## 一、Railway 部署（只要點兩個地方）

1. Railway → New Project → **Deploy from GitHub repo** → 選 `chase5ws/2026_google_form_limiter`。Railway 會自動讀取最外層的 `package.json` 和 `railway.json`，什麼都不用設定。
2. **Settings → Networking → Generate Domain**，拿到 `xxxx.up.railway.app`。
3. **掛 Volume**：在服務上按右鍵 → **Attach Volume**，掛載路徑填 `/data`。

就這樣，**不用設定任何環境變數**：

| 原本要手動設的 | 現在 |
|---|---|
| `DATA_DIR` | 自動讀取 Railway 提供的 Volume 掛載路徑 |
| `ENCRYPTION_KEY` | 第一次啟動自動產生，存在 Volume 裡的 `.encryption-key` |
| `APP_URL` | 自動讀取 Railway 網域 |
| Google 用戶端 ID／密鑰 | 在網頁「平台設定」填，加密存放、不用重新部署 |
| 寄信（Resend／SMTP） | 在網頁「平台設定」填，加密存放、不用重新部署 |

> 想用指令完成第 2、3 步也可以（要先 `npx @railway/cli login` 並在 repo 資料夾執行 `npx @railway/cli link`）：
> ```bash
> npx @railway/cli volume add --mount-path /data
> npx @railway/cli domain
> ```

## 二、打開網站，照「平台設定」的清單做

1. 打開網域登入：有設 `ADMIN_ACCOUNT`／`ADMIN_PASSWORD` 就用那組帳密直接登入；沒設的話用 **`chase5ws` / `chase5ws`**，第一次會要求改密碼。
2. 登入後會直接進到 **平台設定**，最上面的「設定進度」會列出還沒完成的項目，並偵測網域和 Volume 有沒有設定好。
3. **Google OAuth 用戶端**：照頁面上的 3 個連結到 Google Cloud 操作（用平台的 Google 帳號，例如 chase5ws@gmail.com）：
   1. 建立專案，啟用 Forms API 和 Drive API。
   2. OAuth 同意畫面：目標對象選「外部」，**按「發布應用程式」**。停在「測試中」的話，授權每 7 天就會失效。不用送審。
   3. 建立用戶端，類型選「網頁應用程式」。「已授權的重新導向 URI」按頁面上的「複製」貼上，然後把用戶端 ID 和密鑰貼回平台，儲存。
4. **連接 Google**：按「連接 Google」→ 看到未驗證的警告，點「進階 → 前往」→「允許」。
5. **平台預設寄信**（選填）：每個組織會在自己的「組織設定」填寄信帳號。這裡只是組織沒設定時的備用，**留空就只用組織自己的**。

### 進階：用環境變數覆蓋（選填）
有設定的話會優先使用，網頁上就不能改。

| 變數 | 用途 |
|---|---|
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` | Google 用戶端 |
| `RESEND_API_KEY` `MAIL_FROM` 或 `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `MAIL_FROM` | 平台預設寄信（組織沒設定自己的寄信帳號時才用） |
| `ENCRYPTION_KEY` | 自訂加密金鑰（設定後不要改，改了要重新連接 Google、重填寄信設定） |
| `DATA_DIR` | 自訂資料位置 |
| `APP_URL` | 綁自訂網域時填，例如 `https://forms.example.com` |
| `CHECK_INTERVAL_SECONDS` | 檢查間隔，預設 `60` |
| `DRIVE_FOLDER_NAME` | 組織共用資料夾名稱，預設 `表單限額平台`，也可以在網頁改 |
| `ADMIN_ACCOUNT` | 平台管理員帳號，預設 `chase5ws`（3–32 個英文小寫、數字、. _ -） |
| `ADMIN_PASSWORD` | 平台管理員密碼，第一次登入不用改；忘記密碼時換一個值，見下方說明 |

**之後每次 push 到 `main`，只要改到平台的程式（`server.js`、`lib/`、`public/`、`package.json`、`railway.json`），Railway 就會自動重新部署。** 只改文件不會觸發。資料存在 Volume，不受部署影響。

### 部署緩衝（30 秒）
`railway.json` 已設定 `drainingSeconds: 30`：部署新版時，舊版先收到 SIGTERM，30 秒後才會被強制關閉。這段時間舊版會：
1. 不再接受新的請求（回應「系統正在更新，請 30 秒後再試」）
2. 等目前的表單檢查、寄信做完
3. 把 SQLite 的 WAL 寫回主檔，再關閉

如果 Railway 後台的 Settings → Deploy 有另外設定 Draining Seconds，以後台為準，記得也設成 30。

### 平台管理員帳密（建議設定）
在 Railway → 服務 → **Variables** 新增兩個變數：

| 變數 | 值 |
|---|---|
| `ADMIN_ACCOUNT` | 你的帳號，例如 `chase5ws`（沒設就是 `chase5ws`） |
| `ADMIN_PASSWORD` | 你的密碼 |

- 直接用這組帳密登入，**第一次不用改密碼**。
- 之後改 `ADMIN_ACCOUNT` 會**另外建立**一個新的平台管理員，舊帳號不會被刪除，可以在「平台設定 → 平台管理員」停用或刪除。
- 之後一樣可以在網頁右上角「改密碼」自己改。重啟或重新部署**不會**把它改回去，因為同一個值只會套用一次。
- **忘記密碼時**：把 `ADMIN_PASSWORD` 改成另一個值，重新部署後就能用新的值登入。所有裝置會被登出，登入鎖定也會解除。
- 密碼只存在 Railway，**不要寫進程式碼**，因為這個 repo 是公開的。

沒設 `ADMIN_PASSWORD` 的話，預設帳密是 `ADMIN_ACCOUNT`（或 `chase5ws`）／`chase5ws`，第一次登入會要求改密碼。

組織的帳號忘記密碼：由組織管理員或平台管理員在「帳號」分頁按「重設密碼」。

## 三、日常使用

### 平台管理員（你）
1. 完成上面「平台設定」的清單。在同一頁確認「組織共用資料夾名稱」，預設是「表單限額平台」，可以改成你要的名稱。
2. **所有組織 → 建立組織**：填組織名稱和第一位組織管理員。帳密會自動複製到剪貼簿，私訊給對方。
3. 上方「管理組織」下拉選單可以切換到任一組織，替他們處理表單或帳號。

### 組織管理員
1. 用你給的帳密登入，改成自己的密碼。
2. 在自己的 Google 雲端硬碟**建立資料夾，名稱必須是「表單限額平台」**（或你在平台設定改的名稱）。
3. 對資料夾按右鍵 →「共用」，把平台的 Gmail 加為**編輯者**。畫面上會顯示要加哪個 Gmail。
4. 平台「表單」分頁 → 貼上資料夾連結 →「連結資料夾」。這個步驟只要做一次。
5. 在資料夾裡建立表單，或把現有表單移進來，回平台按「重新整理」，再按「加入管理」。
6. 設定名額、開放和截止時間。需要的話，勾選「名額已滿時寄信通知」。
7. 要寄通知的話，到 **組織設定 → 寄信帳號** 填你們自己的寄信方式，信會用你們的寄件者寄出：
   - **Resend**（建議）：到 [resend.com](https://resend.com/domains) 驗證你們的網域，填寄件者和 API Key。
   - **SMTP**：例如組織的 Gmail，填 `smtp.gmail.com`、`465`、Gmail 帳號和[應用程式密碼](https://myaccount.google.com/apppasswords)。**只有平台的 Railway 是 Pro 方案才能用**，Hobby 方案會被封鎖。
   - 儲存後寄一封測試信確認。
8. 填寫連結**不變**，照常發給大家就好。
9. 「帳號」分頁可以新增同事。組織成員能管理表單，但不能設定資料夾、寄信和帳號。

### 名額已滿通知怎麼運作
- 每分鐘讀一次回覆，依**送出時間**排位。第 1 到 N 名是正取，N+1 名之後是候補。
- 候補的人會收到「候補」信，例如「您的報名順位是第 32 位（候補第 2 位）」。
- 管理員在 Google 表單刪掉某筆回覆後，排位會重算。原本候補、現在排進名額內的人，會收到「遞補成功」信。
- 每人每種信只寄一次。寄失敗會重試，最多 3 次。卡片上的「寄信紀錄」可以看到每一封信的狀態。
- 收件 Email 有兩種來源：
  - 表單開啟「收集電子郵件地址」（表單設定 → 回覆）
  - 另外指定一題讓填寫者輸入 Email 的簡答題
- 信件主旨和內容可以自訂，能用 `{title}` `{org}` `{rank}` `{limit}` `{waitlist}` 這幾個變數。

## 誰的帳號做什麼

| 用途 | 帳號 |
|---|---|
| 登入平台、開關表單、讀回覆數 | **平台**的 Google 帳號（你的 Gmail），只需要連接一次 |
| 共用資料夾、表單、回覆、上傳的檔案 | **組織**自己的 Google 帳號，容量也算組織的 |
| 寄候補／遞補通知 | **組織**自己的寄信帳號（組織設定 → 寄信帳號）；沒設定時才用平台預設 |

## 雲端硬碟與容量

- 平台**不會**在你的雲端硬碟建立任何檔案。表單由組織擁有，容量算在組織身上。
- 平台的 Google 權限只有三項：
  - 讀取雲端硬碟的**檔案清單**（`drive.metadata.readonly`），用來列出資料夾裡的表單
  - **開關表單**（`forms.body`）
  - **讀取回覆**（`forms.responses.readonly`），用來計算份數和排位
- 組織只能加入**放在自己共用資料夾裡**的表單，其他地方的表單會被拒絕。
- 組織把資料夾的共用取消後，該組織的表單卡片會顯示錯誤，表單會停在最後的狀態。

## 安全設計

- 密碼用 scrypt 雜湊。Google 授權、用戶端密鑰、寄信密碼都用 AES-256-GCM 加密後存放，金鑰存在 Volume 的 `.encryption-key`（權限 600）或環境變數 `ENCRYPTION_KEY`。
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
npm start                                   # http://localhost:3000，資料存在 ./data
npm test                                    # API、SMTP、優雅關閉測試（模擬 Google）
node test/platform/ui.run.js ./test/platform/shots   # 介面測試（需要 Playwright）
```
