# 🛰️ VS Code Antigravity Telegram Bridge

> **Control your VS Code Antigravity AI Agent remotely via Telegram**  
> 透過 Chrome DevTools Protocol (CDP) 與本機 VS Code 的 **Antigravity** 擴充介面連接，並串接 **Telegram Bot**，實現手機遠端指派任務、一鍵審批 Tool Call 授權、切換模型、動態排程與 Skills 技能調用。

---

## ✨ 核心特色 (Key Features)

* 📱 **隨時隨地遠端對話 (Remote Agent Interaction)**：不在電腦前也能透過 Telegram 手機端直接指派任務、提問與對話，完成後自動推播結果。
* ⚡ **一鍵審批授權 (One-Click Action Approval)**：即時攔截 Antigravity 的 Tool Call / 終端機執行 / 檔案修改等授權請求卡片，在手機上一鍵點擊 `Allow` 或 `Reject`。
* 🔄 **模型動態切換與額度監控 (`/models`, `/usage`)**：免開電腦螢幕，直接在 Telegram 瀏覽可用模型清單、按鈕快速切換，並即時查詢模型配額與使用量。
* ⏰ **自然語言動態排程 (`/schedule`, `/tasks`)**：支援以自然語言建立定時工作（例如：`/schedule 每個工作日09:00檢查專案進度`），附帶可視化按鈕清單，支援測跑、啟用/停用與刪除。
* 🛠️ **工作區技能深度整合 (`/skills`)**：自動掃描工作區 `.agent/skills/` 下的自定義技能，並以 Inline 按鈕提供一鍵觸發執行。
* 🛡️ **白名單資安防護 (Strict Whitelist Security)**：內建 `ALLOWED_USER_ID` 嚴格身分驗證，非本人 Telegram ID 的訊息將一律自動拒絕，杜絕未授權存取。
* 📸 **即時狀態與螢幕截圖 (`/status`, `/screenshot`)**：隨時掌握 Antigravity 是否連線與忙碌狀態，必要時可即時回傳 VS Code 當前畫面截圖。

---

## 📋 系統先決條件 (Prerequisites)

1. **作業系統**：Windows 10 / 11 (亦相容 macOS / Linux 具備 Chrome DevTools 除錯模式之 VS Code 環境)
2. **Node.js**：建議 **Node.js 18** 或更高版本
3. **VS Code**：已安裝並可正常運行 **Antigravity** 擴充功能
4. **Telegram 帳號**：用於接收推播與發送指令的個人帳號

---

## 🚀 快速上手 (Quick Start)

### 步驟 1：取得 Telegram Bot Token 與個人 User ID

1. **取得 Bot Token**：
   * 在 Telegram 搜尋官方機器人 [`@BotFather`](https://t.me/BotFather)，發送 `/newbot`。
   * 依照指示設定機器人名稱，完成後取得專屬的 **`API Token`**。
2. **取得您的 Telegram User ID**：
   * 在 Telegram 搜尋 [`@userinfobot`](https://t.me/userinfobot)，點擊 Start。
   * 機器人將回傳一串純數字的 **`Id`**（此為個人白名單驗證使用，防止他人盜用）。

---

### 步驟 2：設定環境變數 (`.env`)

1. 將專案根目錄下的 `.env.example` 複製一份並重新命名為 **`.env`**：
   ```bash
   cp .env.example .env
   ```
2. 使用任何文字編輯器打開 `.env`，填入前一步驟取得的資訊：
   ```env
   # Telegram Bot Token (必填)
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ

   # 您的 Telegram 個人純數字 ID (必填，白名單防護)
   ALLOWED_USER_ID=123456789

   # CDP 除錯通訊埠 (預設 9222 即可)
   CDP_PORT=9222

   # 狀態推播時顯示的自訂工作區名稱
   TARGET_PROJECT_NAME=my_workspace
   ```

---

### 步驟 3：一鍵啟動

#### Windows 使用者（推薦）：
直接滑鼠雙擊執行 **`start_bridge.bat`**。  
腳本將自動：
1. 檢查 `.env` 設定。
2. 自動執行 `npm install` 安裝相依套件（首次執行時）。
3. 自動以 `--remote-debugging-port=9222` 參數啟動 VS Code。
4. 啟動 Node.js 橋接服務。

> ⚠️ **重要提示**：若您的 VS Code 原先已在執行（但未開啟 9222 除錯埠），請依腳本提示**完全關閉所有 VS Code 視窗**後再繼續，否則除錯埠無法成功附加。

#### 指令列啟動（跨平台）：
```bash
# 1. 安裝相依套件
npm install

# 2. 啟動 VS Code (需帶除錯埠參數)
code --remote-debugging-port=9222

# 3. 啟動 Bridge
npm start
```

---

## 📱 Telegram 指令一覽 (Bot Commands)

啟動成功後，打開 Telegram 向您的機器人發送以下指令：

| 指令 | 說明 |
| :--- | :--- |
| **直接發送文字** | 將需求指派給 Antigravity 執行，完成後自動將結果推播回手機 |
| **發送圖片 (+ 文字說明)** | 上傳圖片並附帶提示詞，供多模態模型進行分析或除錯 |
| `/skills` | 瀏覽工作區自定義技能 (`.agent/skills`)，以 Inline 按鈕一鍵發動 |
| `/schedule <需求>` | 以自然語言新增排程任務（例：`/schedule 每個平日18:00整理代碼`） |
| `/tasks` | 管理排程清單（支援按鈕即時手動測跑、啟用/停用切換、刪除） |
| `/models` | 取得 Antigravity 當前可用模型清單，透過按鈕快速切換 |
| `/usage` | 查詢當前各模型的配額與剩餘使用量 |
| `/status` | 檢查 CDP 連線狀況與 Antigravity 忙碌狀態 |
| `/screenshot` | 即時截圖並回傳 VS Code 當前畫面 |
| `/new` | 開啟新的對話 Session |
| `/stop` | 中斷 / 暫停 Antigravity 當前執行動作 |
| `/help` | 顯示完整指令幫助清單 |

---

## 🛡️ 安全注意事項 (Security)

1. **妥善保管金鑰**：
   * `.env` 檔案內含個人 Bot Token 與 User ID，已預設加入 `.gitignore`，**嚴禁上傳至任何公開儲存庫**。
2. **白名單機制**：
   * 專案內建強制的 `ALLOWED_USER_ID` 驗證，所有非白名單使用者的對話、點擊與照片皆會被立即攔截並拒絕。
3. **除錯埠網路隔離**：
   * CDP 除錯埠（`9222`）預設僅綁定於本機端（`localhost` / `127.0.0.1`），請勿任意將除錯埠暴露至公開外部網路。

---

## 📄 授權條款 (License)

本專案採用 [MIT License](LICENSE) 授權發布。

