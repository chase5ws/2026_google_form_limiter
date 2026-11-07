# 2026_google_form_limiter

Google 表單限額管理後台。用 Google Apps Script（GAS）做成網頁版，管理員登入後可以：

- **設定名額上限**：回覆數到了就自動關閉表單
- **設定開放／截止時間**：時間到自動開啟、關閉
- **手動立即關閉／開放**、自訂關閉時顯示給填寫者的訊息
- **管理帳號**（最高管理員）：新增、停用、刪除管理員，重設密碼，升降權限
- **操作紀錄**：誰在什麼時候改了什麼、系統何時自動開關

這個 repo 只放程式碼。程式實際在 Google Apps Script 上執行，資料存在該專案的「指令碼屬性」。推到 `main` 會由 GitHub Actions 自動更新到 Apps Script。

```
src/
  Code.gs           後端：登入、管理員、表單規則、觸發器
  Index.html        網頁介面
  appsscript.json   GAS 設定（時區、權限、網頁應用程式）
test/
  gasmock.js        在 Node 模擬 GAS 服務
  backend.test.js   後端測試（GitHub Actions 部署前會先跑）
  ui.test.js        介面測試（需要 Playwright，本機用）
.github/workflows/deploy.yml   push 到 main 自動部署
```

---

## 運作方式

| 時機 | 做什麼 |
|---|---|
| 有人送出表單 | 立刻數回覆數，滿了就關閉 |
| 每 5 分鐘 | 檢查所有表單的開放／截止時間，順便補檢查名額 |
| 管理員改設定 | 馬上套用，例如把上限調高，表單會自動重新開放 |

表單狀態的判斷順序是：手動關閉 → 尚未開放 → 已截止 → 名額已滿 → 開放。手動關閉的表單不會被自動打開，要在後台按「開放」。

**限制**
- Google 表單本身沒有「硬上限」。如果很多人在同一秒送出，可能多收 1～2 份。
- 一個 Apps Script 專案最多 20 個觸發器，其中 1 個是定時檢查。所以前 19 份表單有「送出即檢查」，第 20 份起只靠每 5 分鐘檢查，後台會標示出來。
- 部署帳號必須有表單的**編輯權限**。

---

## 第一次設定

### 1. 建立 Apps Script 專案
1. 到 <https://script.google.com> → 新專案，命名例如「表單限額管理」。
2. 左側「專案設定 ⚙️」→ 複製 **指令碼 ID**（Script ID）。
3. 到 <https://script.google.com/home/usersettings> 把 **Google Apps Script API** 打開（clasp 需要）。

### 2. 在自己電腦登入 clasp（只做一次）
```bash
npm install -g @google/clasp@2.4.2
clasp login            # 會開瀏覽器，用「擁有表單的那個 Google 帳號」登入
cat ~/.clasprc.json    # 整段內容等一下要貼進 GitHub Secret
```
> 請固定用 2.4.2 版。clasp 3.x 的憑證格式不同，跟 workflow 不相容。

### 3. 設定 GitHub Secrets
repo → Settings → Secrets and variables → Actions → New repository secret：

| 名稱 | 內容 |
|---|---|
| `CLASPRC_JSON` | `~/.clasprc.json` 的完整內容 |
| `SCRIPT_ID` | 第 1 步複製的指令碼 ID |
| `DEPLOYMENT_ID` | 第 5 步才會拿到，先不用填 |

設好後到 Actions → **Deploy to Apps Script** → Run workflow，程式碼就會推上 Apps Script。

### 4. 建立最高管理員
1. 打開 Apps Script 編輯器 → 專案設定 → **指令碼屬性** → 新增：
   - `INIT_OWNER_PASSWORD`：第一次登入用的暫時密碼
   - `INIT_OWNER_USER`：選填，預設是 `chase5ws`
2. 回到編輯器，上方函式選單選 **`setupOwner`** → 執行 → 依指示授權。
3. 執行完成後，`INIT_OWNER_PASSWORD` 會被自動刪除，系統也會裝好每 5 分鐘的定時檢查。

> 忘記密碼時用同樣方法：設 `INIT_OWNER_PASSWORD` 再執行一次 `setupOwner`。密碼會被重設，所有已登入的裝置都會被登出。

### 5. 部署成網頁
1. 編輯器右上「部署」→「新增部署作業」→ 類型選 **網頁應用程式**。
   - 執行身分：**我**
   - 誰可以存取：**所有人**（其他管理員不需要 Google 帳號，靠後台自己的帳號密碼擋）
2. 部署後會拿到 **網頁應用程式網址**（`https://script.google.com/macros/s/…/exec`），這就是後台網址。
3. 同一個畫面的 **部署作業 ID** 貼到 GitHub Secret `DEPLOYMENT_ID`。之後每次 push，這個網址都會自動換成最新版本，網址不變。
4. 打開後台網址，用 `chase5ws` 和剛剛的暫時密碼登入，系統會要求你改成自己的密碼。

---

## 日常使用

- **加入表單**：貼上表單的「編輯」網址（`https://docs.google.com/forms/d/…/edit`）。填寫網址（`/d/e/…`、`forms.gle`）不行。
- **新增管理員**：「管理員」分頁 → 新增管理員。系統會產生暫時密碼並複製到剪貼簿，私訊給對方即可。對方第一次登入要改密碼。
- **一般管理員**只能管理表單；**最高管理員**另外可以管理帳號。系統至少會保留一位啟用中的最高管理員。

## 安全設計

- 密碼以隨機鹽加 1000 輪 HMAC-SHA256 雜湊後存放，不存明碼，也不會出現在 repo 裡。
- 同一帳號連續登入失敗 5 次，會鎖 15 分鐘。
- 登入 token 在 6 小時沒有動作後失效。改密碼、被停用或被重設密碼時，舊的登入會立即失效。
- 後端函式名稱結尾是 `_` 的，前端無法呼叫。其他 API 都會先驗證 token 和權限。

## 自動部署（GitHub Actions）

`.github/workflows/deploy.yml`：push 到 `main`，而且有改到 `src/` 或測試時，會依序：
1. 跑 `node test/backend.test.js`，測試沒過就不部署。
2. `clasp push --force` 把 `src/` 推上 Apps Script。
3. 有設 `DEPLOYMENT_ID` 的話，執行 `clasp deploy --deploymentId …` 更新網頁版本。

也可以在 Actions 頁面按 **Run workflow** 手動部署。

## 本機測試
```bash
node test/backend.test.js                  # 後端邏輯，不需要安裝任何套件
npx playwright install chromium            # 只有介面測試需要
node test/ui.test.js ./test/shots          # 截圖存到 test/shots/
```
