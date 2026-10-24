require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Telegraf } = require('telegraf');
const puppeteer = require('puppeteer-core');
const { getAntigravityModels, switchAntigravityModel } = require('./get_models');
const {
  SchedulerManager,
  DEFAULT_TIMEZONE,
  parseScheduleFast,
  calculateNextRun
} = require('./scheduler');
const { getWorkspaceSkills, renderSkillsMessage, escapeMarkdown } = require('./skills');

const scheduler = new SchedulerManager();
const pendingSchedules = new Map(); // confirmId -> { name, cron, prompt, source }

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedId = process.env.ALLOWED_USER_ID;
const cdpPort = process.env.CDP_PORT || 9222;
const targetProject = process.env.TARGET_PROJECT_NAME || 'my_workspace';

console.log('--- 檢查環境變數 ---');
console.log('BOT TOKEN 存在:', !!token);
console.log('ALLOWED USER ID:', allowedId ? (String(allowedId).length > 4 ? `${String(allowedId).slice(0, 3)}***${String(allowedId).slice(-2)}` : '***') : '未設定');
console.log('CDP PORT:', cdpPort);
console.log('TARGET PROJECT:', targetProject);
console.log('--------------------');

if (!token) {
  console.error('錯誤：未讀取到 TELEGRAM_BOT_TOKEN，請檢查 .env 檔案！');
  process.exit(1);
}

const bot = new Telegraf(token);
let browser = null;
let activeInteractionSession = null; // 當前等待使用者確認的互動階段（審核/提問/授權）
let activeTakeoverSession = null; // 當前等待授權的 Takeover 卡片階段
let globalTakeoverSignature = ''; // 背景常駐監聽防重複推播籤章

async function getBrowser() {
  const isAlive = browser && (
    typeof browser.isConnected === 'function' ? browser.isConnected() : browser.connected
  );

  if (!isAlive) {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${cdpPort}`,
      defaultViewport: null
    });
  }
  return browser;
}

// 實地探測：找出「真正擁有輸入框」的 Webview Target
async function findAntigravityInputTarget() {
  const b = await getBrowser();
  const targets = b.targets();

  // 篩選出所有可能的 Webview Targets
  const candidateTargets = targets.filter(t => {
    const url = t.url();
    return url.includes('127.0.0.1') || url.includes('vscode-webview') || url.includes('extensionView');
  });

  for (const target of candidateTargets) {
    try {
      const client = await target.createCDPSession();
      const evalRes = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const input = document.querySelector('[aria-label="Message input"]');
          return !!input;
        })()`,
        returnByValue: true
      });
      await client.detach().catch(() => { });

      if (evalRes?.result?.value === true) {
        return target;
      }
    } catch {
      // 略過不可通訊的 target
    }
  }

  return null;
}

// 輪詢等待真正的輸入框 Target
async function waitForAntigravityTarget(maxRetries = 15, intervalMs = 1500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[輪詢偵測] 第 ${attempt}/${maxRetries} 次探測 Antigravity 輸入框...`);
    const target = await findAntigravityInputTarget();
    if (target) {
      console.log(`🎉 鎖定有效 Antigravity Webview Target: ${target.url().slice(0, 60)}...`);
      return target;
    }
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  return null;
}

// 傳送指令至 Antigravity 並等待完整回覆（雙向通訊）
async function sendAndAwaitAntigravityReply(text, onStatusUpdate, chatId = allowedId) {
  const target = await waitForAntigravityTarget(5, 1200);
  if (!target) {
    throw new Error(`未在 [${targetProject}] 中找到 Antigravity 輸入框，請確認側邊欄已展開！`);
  }

  let client = null;

  // 提取使用者的前綴關鍵字以供精準定位本輪對話（取前 20 個字元）
  const promptKey = text.trim().slice(0, 20);

  let typingTimer = null;
  let hasBinding = false;
  let onBindingCalled = null;

  
      
  try {
    client = await target.createCDPSession();
    // --- 第零步：記錄送出前的對話狀態（避免誤判上一輪對話）---
    const preCheck = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const turns = Array.from(document.querySelectorAll('[class*="scroll-mt-4"]'));
        return {
          turnsCount: turns.length
        };
      })()`,
      returnByValue: true
    });
    const initialTurnsCount = preCheck?.result?.value?.turnsCount || 0;

    // --- 第一步：填入文字並觸發送出（CDP 原生 Input.insertText 多行支援 ＋ DOM Paste 雙重保證）---
    let evalResult;
    try {
      // 1. 聚焦並清空輸入框
      const focusRes = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const inputDiv = document.querySelector('[aria-label="Message input"]');
          if (!inputDiv) return { success: false, reason: '找不到 [aria-label="Message input"]' };
          inputDiv.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          return { success: true };
        })()`,
        returnByValue: true
      });

      if (!focusRes?.result?.value?.success) {
        throw new Error(focusRes?.result?.value?.reason || '聚焦輸入框失敗');
      }

      // 2. 優先使用 CDP 原生 Input.insertText 注入完整多行文字（絕不吃字、完整保留 \n 換行）
      try {
        await client.send('Input.insertText', { text });
      } catch (cdpInputErr) {
        console.warn('[CDP 輸入警告] Input.insertText 失敗，改用 Clipboard 注入:', cdpInputErr.message);
      }

      // 3. 檢查文字是否成功進入，若未成功則以 ClipboardEvent('paste') 保底，並觸發點擊送出
      evalResult = await client.send('Runtime.evaluate', {
        expression: `(async (msg) => {
          const inputDiv = document.querySelector('[aria-label="Message input"]');
          if (!inputDiv) return { success: false, reason: '找不到 [aria-label="Message input"]' };

          inputDiv.dispatchEvent(new Event('input', { bubbles: true }));
          inputDiv.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(r => setTimeout(r, 80));

          const hasText = inputDiv.innerText.trim().length > 0 || inputDiv.textContent.trim().length > 0;
          if (!hasText) {
            // 保底方案：使用 DataTransfer ClipboardEvent('paste') 整批貼上
            const dt = new DataTransfer();
            dt.setData('text/plain', msg);
            const pasteEvent = new ClipboardEvent('paste', {
              clipboardData: dt,
              bubbles: true,
              cancelable: true
            });
            inputDiv.dispatchEvent(pasteEvent);
            inputDiv.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 100));
          }

          await new Promise(r => setTimeout(r, 150));

          const sendBtn = document.querySelector('button[aria-label="Send message"]');
          if (sendBtn && !sendBtn.disabled && !sendBtn.classList.contains('cursor-not-allowed')) {
            sendBtn.click();
            return { success: true, method: 'button_click' };
          }

          const enterDown = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          });
          inputDiv.dispatchEvent(enterDown);

          return { success: true, method: 'enter_key' };
        })(${JSON.stringify(text)})`,
        awaitPromise: true,
        returnByValue: true
      });
    } catch (err) {
      // 攔截頁面重置導致的 Promise was collected 錯誤，並視為觸發成功
      if (err.message.includes('Promise was collected') || err.message.includes('Execution context was destroyed')) {
        console.log('[送出警告] 點擊送出後 Webview 發生重置 (Promise was collected)，視為成功送出。');
        evalResult = {
          result: {
            value: { success: true, method: 'forced_success_due_to_navigation' }
          }
        };
      } else {
        throw err; // 如果是其他錯誤，則正常拋出
      }
    }

    const resVal = evalResult?.result?.value;
    if (!resVal || !resVal.success) {
      throw new Error(resVal?.reason || '文字填入或點擊送出未生效');
    }
    console.log(`[送出成功] 觸發方式: ${resVal.method}`);

    // --- 啟動手機端 Typing 中間狀態指示（消除黑盒子等待感）---
    const targetChatId = chatId || allowedId;
    // typingTimer 已移至外層宣告以供 finally 區塊釋放資源
    if (targetChatId) {
      bot.telegram.sendChatAction(targetChatId, 'typing').catch(() => { });
      typingTimer = setInterval(() => {
        bot.telegram.sendChatAction(targetChatId, 'typing').catch(() => { });
      }, 4000);
    }

    // --- 第一重保固：注入 MutationObserver 事件驅動監聽層 ---
    let eventCompletionTriggered = false;
    let eventDetectedInteraction = null;

    onBindingCalled = (evt) => {
      if (evt.name === '__bridgeDomSignal') {
        try {
          const data = JSON.parse(evt.payload);
          if (data.type === 'completed') {
            eventCompletionTriggered = true;
          } else if (data.type === 'interaction') {
            eventDetectedInteraction = data.payload;
          }
        } catch (err) { }
      }
    };

    hasBinding = false;
    try {
      await client.send('Runtime.addBinding', { name: '__bridgeDomSignal' });
      client.on('Runtime.bindingCalled', onBindingCalled);
      hasBinding = true;
    } catch (e) {
      console.log('[雙重保固架構] Webview 未啟用 addBinding，自動由定時輪詢層完全保底');
    }

    // --- 第二步：等待本輪開始執行（出現 Cancel/Stop 按鈕，或出現新的輪次）---
    let hasStartedGenerating = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 400));
      const checkGen = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const cancelOrStopBtn = document.querySelector('button[aria-label*="Cancel"], button[aria-label*="Stop"], button[title*="Cancel"], button[title*="Stop"]');
          const turns = Array.from(document.querySelectorAll('[class*="scroll-mt-4"]'));
          const hasNewTurn = turns.length > ${initialTurnsCount};
          const latestTurn = document.querySelector('[data-turn-content="latest"]') || turns[turns.length - 1];
          const hasAgentArticle = latestTurn ? !!latestTurn.querySelector('[aria-label="Agent response"]') : false;
          return !!cancelOrStopBtn || hasNewTurn || hasAgentArticle;
        })()`,
        returnByValue: true
      });
      if (checkGen?.result?.value) {
        hasStartedGenerating = true;
        if (typeof onStatusUpdate === 'function') {
          onStatusUpdate('generating');
        }
        console.log('[任務啟動] 偵測到 Antigravity 已正式開始執行本輪任務！');
        break;
      }
    }

    // 掛載 DOM MutationObserver 監聽器（毫秒級主動回報）
    try {
      await client.send('Runtime.evaluate', {
        expression: `(() => {
          if (window.__bridgeObserver) {
            try { window.__bridgeObserver.disconnect(); } catch (e) {}
            window.__bridgeObserver = null;
          }

          let lastSig = '';
          const checkState = () => {
            // 1. 偵測 Takeover 授權卡片
            const takeoverCard = document.querySelector('[data-testid="interaction-takeover-card"]');
            if (takeoverCard && takeoverCard.offsetParent !== null) {
              const headerEl = takeoverCard.querySelector('[data-testid="ask-question-header-text"]');
              const headerText = headerEl ? headerEl.innerText.trim() : 'Antigravity 請求確認';
              const targetEl = takeoverCard.querySelector('[data-testid="permission-target-editor"], pre');
              const targetText = targetEl ? (targetEl.value || targetEl.innerText || '').trim() : '';
              const options = [];
              const optLabels = Array.from(takeoverCard.querySelectorAll('[data-testid="ask-question-option"]'));
              optLabels.forEach((label, idx) => {
                const radio = label.querySelector('input[type="radio"]');
                const textEl = label.querySelector('[data-testid="ask-question-option-text"]');
                const optText = textEl ? textEl.innerText.trim() : ('選項 ' + (idx + 1));
                const val = radio ? radio.value : String(idx + 1);
                options.push({ rawVal: val, label: (idx + 1) + '. ' + optText });
              });
              const noLabel = takeoverCard.querySelector('label[for*="__write_in__"]');
              if (noLabel) {
                const radio = noLabel.querySelector('input[type="radio"]');
                options.push({ rawVal: radio ? radio.value : '__write_in__', label: '5. 拒絕 (No)' });
              }
              const skipBtn = takeoverCard.querySelector('[data-testid="interaction-skip-button"]');
              if (skipBtn) {
                options.push({ rawVal: 'skip', label: '略過 (Skip)' });
              }
              const sig = 'takeover::' + headerText + '::' + targetText + '::' + options.map(o => o.label).join('|');
              if (sig !== lastSig && typeof window.__bridgeDomSignal === 'function') {
                lastSig = sig;
                window.__bridgeDomSignal(JSON.stringify({
                  type: 'interaction',
                  payload: { type: 'takeover', header: headerText, target: targetText, options }
                }));
              }
              return;
            }

            // 2. 偵測完成狀態 (Cancel/Stop 按鈕消失且 Send message 按鈕回歸)
            const cancelBtn = document.querySelector('button[aria-label*="Cancel"], button[aria-label*="Stop"], button[title*="Cancel"], button[title*="Stop"]');
            const sendBtn = document.querySelector('button[aria-label="Send message"]');
            const turns = Array.from(document.querySelectorAll('[class*="scroll-mt-4"]'));
            const latestTurn = document.querySelector('[data-turn-content="latest"]') || turns[turns.length - 1];
            const agentArticle = latestTurn ? latestTurn.querySelector('[aria-label="Agent response"]') : null;

            if (!cancelBtn && sendBtn && agentArticle && typeof window.__bridgeDomSignal === 'function') {
              const mdEls = Array.from(agentArticle.querySelectorAll('.leading-relaxed, [class*="select-text"]:not(button):not(span), .rendered-markdown, [class*="prose"]'));
              const mdLen = mdEls.reduce((acc, el) => acc + (el.innerText ? el.innerText.trim().length : 0), 0);
              if (mdLen > 10) {
                window.__bridgeDomSignal(JSON.stringify({ type: 'completed' }));
              }
            }
          };

          const observer = new MutationObserver(() => checkState());
          observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-label', 'title', 'disabled', 'class', 'style']
          });
          window.__bridgeObserver = observer;
          checkState();
        })()`,
        returnByValue: true
      });
    } catch (obsErr) {
      console.warn('[事件層提示] Observer 掛載跳過，由輪詢層保底');
    }

    // --- 第三步：等待本輪生成完畢（Cancel/Stop 按鈕消失且 Send message 按鈕重新回歸）---
    const maxWaitTimeMs = 25 * 60 * 1000; // 最長等待 25 分鐘
    const pollIntervalMs = 1200;
    const startTime = Date.now();
    let consecutiveIdleCount = 0;
    let lastNotifiedActionSignature = '';

    while (Date.now() - startTime < maxWaitTimeMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));

      const pollRes = await client.send('Runtime.evaluate', {
        expression: `(() => {
          // 核心 1：偵測終止按鈕（執行中必然為 "Cancel (Ctrl+D)" 或包含 Stop 的按鈕）
          const cancelOrStopBtn = document.querySelector('button[aria-label*="Cancel"], button[aria-label*="Stop"], button[title*="Cancel"], button[title*="Stop"]');
          const isWorking = !!cancelOrStopBtn;

          // 核心 2：發送按鈕重新回歸
          const sendBtn = document.querySelector('button[aria-label="Send message"]');
          const hasSendReturned = !!sendBtn;

          // 核心 3：鎖定最新一輪對話（絕不使用歷史模糊比對）
          const turns = Array.from(document.querySelectorAll('[class*="scroll-mt-4"]'));
          const latestTurn = document.querySelector('[data-turn-content="latest"]') || turns[turns.length - 1];
          const agentArticle = latestTurn ? latestTurn.querySelector('[aria-label="Agent response"]') : null;

          // 檢查最新一輪 Markdown 內容長度
          let mdLen = 0;
          if (agentArticle) {
            const mdEls = Array.from(agentArticle.querySelectorAll('.leading-relaxed, [class*="select-text"]:not(button):not(span), .rendered-markdown, [class*="prose"]'));
            mdLen = mdEls.reduce((acc, el) => acc + (el.innerText ? el.innerText.trim().length : 0), 0);
          }

          return {
            isWorking,
            hasSendReturned,
            hasAgentArticle: !!agentArticle,
            mdLen
          };
        })()`,
        returnByValue: true
      });

      // --- 核心優化：偵測 Antigravity 是否正在等待權限審核、操作確認或提問選項（事件層 + 輪詢層雙重檢查）---
      try {
        const detectRes = await client.send('Runtime.evaluate', {
          expression: `(() => {
            // 優先檢查 Takeover 卡片（Antigravity 官方權限確認與提問卡片）
            const takeoverCard = document.querySelector('[data-testid="interaction-takeover-card"]');
            if (takeoverCard && takeoverCard.offsetParent !== null) {
              const headerEl = takeoverCard.querySelector('[data-testid="ask-question-header-text"]');
              const headerText = headerEl ? headerEl.innerText.trim() : 'Antigravity 請求確認';

              const targetEl = takeoverCard.querySelector('[data-testid="permission-target-editor"], pre');
              const targetText = targetEl ? (targetEl.value || targetEl.innerText || '').trim() : '';

              const options = [];
              const optLabels = Array.from(takeoverCard.querySelectorAll('[data-testid="ask-question-option"]'));
              optLabels.forEach((label, idx) => {
                const radio = label.querySelector('input[type="radio"]');
                const textEl = label.querySelector('[data-testid="ask-question-option-text"]');
                const optText = textEl ? textEl.innerText.trim() : ('選項 ' + (idx + 1));
                const val = radio ? radio.value : String(idx + 1);
                options.push({
                  rawVal: val,
                  label: (idx + 1) + '. ' + optText
                });
              });

              const noLabel = takeoverCard.querySelector('label[for*="__write_in__"]');
              if (noLabel) {
                const radio = noLabel.querySelector('input[type="radio"]');
                const noVal = radio ? radio.value : '__write_in__';
                options.push({
                  rawVal: noVal,
                  label: '5. 拒絕 (No)'
                });
              }

              const skipBtn = takeoverCard.querySelector('[data-testid="interaction-skip-button"]');
              if (skipBtn) {
                options.push({
                  rawVal: 'skip',
                  label: '略過 (Skip)'
                });
              }

              return {
                type: 'takeover',
                header: headerText,
                target: targetText,
                options
              };
            }

            // 次要檢查：通用對話窗或自訂按鈕
            const turns = Array.from(document.querySelectorAll('[class*="scroll-mt-4"]'));
            const latestTurn = document.querySelector('[data-turn-content="latest"]') || turns[turns.length - 1];
            const modal = document.querySelector('[role="dialog"], [role="alertdialog"]');
            const scope = modal || latestTurn;
            if (!scope) return null;

            const allButtons = Array.from(scope.querySelectorAll('button, [role="button"]'));
            const ignoreKeywords = ['copy', 'undo', 'thought for', 'worked for', 'send message', 'cancel', 'feedback', 'toggle', 'maximize', 'minimize', 'close', 'open in', 'dismiss'];
            const approvalRegex = /^(allow|always allow|allow once|deny|reject|proceed|approve|run|run command|confirm|ok|yes|no|允許|總是允許|一律允許|僅允許一次|拒絕|執行|繼續|核准|確認|確定|同意)$/i;

            const detected = [];
            for (let i = 0; i < allButtons.length; i++) {
              const b = allButtons[i];
              if (b.offsetParent === null && !b.getClientRects().length) continue;
              const text = (b.innerText || '').trim();
              const aria = (b.getAttribute('aria-label') || '').trim();
              const title = (b.getAttribute('title') || '').trim();
              const fullDesc = (text + ' ' + aria + ' ' + title).trim().toLowerCase();
              if (!fullDesc || ignoreKeywords.some(kw => fullDesc === kw || fullDesc.startsWith(kw + ' '))) continue;

              if (approvalRegex.test(text) || approvalRegex.test(aria)) {
                let actionId = b.getAttribute('data-bridge-action-id');
                if (!actionId) {
                  actionId = 'act_' + Math.random().toString(36).slice(2, 9);
                  b.setAttribute('data-bridge-action-id', actionId);
                }
                detected.push({ actionId, label: text || aria || title || '確認', isApproval: true });
              }
            }

            if (detected.length > 0) {
              return { type: 'buttons', header: 'Antigravity 請求確認', target: '', options: detected };
            }

            return null;
          })()`,
          returnByValue: true
        });

        const interaction = detectRes?.result?.value;
        if (interaction && interaction.options && interaction.options.length > 0) {
          const sig = interaction.type + '::' + interaction.header + '::' + interaction.target + '::' + interaction.options.map(o => o.label).join('|');
          if (sig !== lastNotifiedActionSignature) {
            lastNotifiedActionSignature = sig;
            console.log(`[偵測到互動請求] 類型: ${interaction.type}, 選項數: ${interaction.options.length}，推播至 Telegram...`);

            activeTakeoverSession = {
              client,
              targetChat: chatId || allowedId,
              options: interaction.options,
              type: interaction.type
            };

            const inlineKeyboard = [];
            for (const opt of interaction.options) {
              const cbData = interaction.type === 'takeover' ? `tkover:${opt.rawVal}` : `act:${opt.actionId}`;
              inlineKeyboard.push([{
                text: opt.label.length > 40 ? opt.label.slice(0, 37) + '...' : opt.label,
                callback_data: cbData
              }]);
            }

            const promptMsg =
              `⚠️ *Antigravity 正在等待您的授權 / 選擇*：\n\n` +
              `❓ *標題*：${escapeMarkdown(interaction.header)}\n` +
              (interaction.target ? `📁 *目標路徑*：\`${escapeMarkdown(interaction.target)}\`\n\n` : '\n') +
              `👇 *請在下方點擊按鈕進行授權或選擇*：`;

            try {
              const targetChat = chatId || allowedId;
              if (targetChat) {
                const card = await bot.telegram.sendMessage(targetChat, promptMsg, {
                  parse_mode: 'Markdown',
                  reply_markup: { inline_keyboard: inlineKeyboard }
                });
                activeTakeoverSession.messageId = card.message_id;
              }
            } catch (pErr) {
              console.warn('[推播互動訊息警告]:', pErr.message);
            }
          }

          consecutiveIdleCount = 0;
          continue;
        } else {
          if (lastNotifiedActionSignature) {
            lastNotifiedActionSignature = '';
          }
        }
      } catch (detErr) {
        // 忽略單次偵測異常
      }

      const poll = pollRes?.result?.value;

      // 只要 isWorking 為 true，代表畫面上仍有 Cancel/Stop 按鈕，絕對不可退出！
      if (!poll || poll.isWorking) {
        consecutiveIdleCount = 0;
        continue;
      }

      // 當 Cancel/Stop 按鈕消失，且 Send message 按鈕回歸，且最新輪次已有 Agent 回覆元件
      if (!poll.isWorking && poll.hasSendReturned && poll.hasAgentArticle) {
        // 🚀 雙重保固加速：若事件層已發出完成訊號，且輪詢層確認符合條件，極速收尾（無需死板等 3.6 秒）
        if (eventCompletionTriggered && poll.mdLen > 10) {
          console.log('[雙重保固極速完成] MutationObserver 事件觸發 ＋ 輪詢狀態確認完畢！');
          await new Promise(r => setTimeout(r, 400));
          break;
        }

        // 若已經渲染出 Markdown，或連續 3 次檢查都處於穩定狀態（每次 1.2s，共約 3.6s 防抖保底）
        if (poll.mdLen > 10) {
          consecutiveIdleCount += 2; // 已有實質內文，加速收尾
        } else {
          consecutiveIdleCount += 1;
        }

        if (consecutiveIdleCount >= 3) {
          console.log('[輪詢保底完成] Cancel/Stop 已消失，Send 按鈕回歸，最新輪次文字已穩定！');
          await new Promise(r => setTimeout(r, 800)); // 額外等待 800ms 確保最後一段 DOM 渲染完成
          break;
        }
      } else {
        consecutiveIdleCount = 0;
      }
    }

    // --- 第四步：精準萃取最新一輪 Agent 的完整回覆文字 ---
    let replyText = '';
    for (let retry = 0; retry < 8; retry++) {
      if (retry > 0) {
        await new Promise(r => setTimeout(r, 600));
      }

      const extractRes = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const turns = Array.from(document.querySelectorAll('[class*="scroll-mt-4"]'));
          const latestTurn = document.querySelector('[data-turn-content="latest"]') || turns[turns.length - 1];
          if (!latestTurn) return null;

          const agentArticle = latestTurn.querySelector('[aria-label="Agent response"]');
          if (!agentArticle) return null;

          // 策略 1：提取 Agent Article 內部所有渲染完成的 Markdown 容器（.leading-relaxed）
          const mdEls = Array.from(agentArticle.querySelectorAll('.leading-relaxed, [class*="select-text"]:not(button):not(span), .rendered-markdown'));
          const texts = mdEls.map(el => el.innerText.trim()).filter(t => t.length > 0);
          if (texts.length > 0) {
            return texts.join('\\n\\n');
          }

          // 策略 2：複製 Agent Article 節點並移除所有工具摺疊鈕與圖示，取得純文字
          const clone = agentArticle.cloneNode(true);
          clone.querySelectorAll('button, svg, [data-testid*="worked-for"], [data-testid*="thought"], [class*="sticky"]').forEach(el => el.remove());
          let cleanText = clone.innerText ? clone.innerText.trim() : '';
          cleanText = cleanText.replace(/^(Worked|Thought)\\s+for\\s+[^\\n]+\\n*/i, '').trim();
          cleanText = cleanText.replace(/\\n*(Good response|Bad response|Copy|\\d+[smhd] ago)+$/gi, '').trim();
          if (cleanText.length > 10) {
            return cleanText;
          }

          return null;
        })()`,
        returnByValue: true
      });

      const extracted = extractRes?.result?.value;
      if (extracted && extracted.trim().length > 10) {
        replyText = extracted.trim();
        console.log(`[擷取成功] 第 ${retry + 1} 次嘗試成功提取回覆（長度: ${replyText.length} 字元）`);
        break;
      }
    }

    if (!replyText) {
      replyText = '（已完成執行，未能即時在畫面擷取到文字，請於 VS Code 介面查看）';
      console.warn('[擷取警告] 多次重試後仍未提取到實質文字回覆！');
    }

    return { success: true, replyText };

  } finally {
    if (typingTimer) {
      clearInterval(typingTimer);
    }
    if (client) {
      if (hasBinding && onBindingCalled) {
        try { client.off('Runtime.bindingCalled', onBindingCalled); } catch (e) {}
      }
      await client.send('Runtime.evaluate', {
        expression: `(() => {
          if (window.__bridgeObserver) {
            try { window.__bridgeObserver.disconnect(); } catch (e) {}
            delete window.__bridgeObserver;
          }
        })()`
      }).catch(() => {});
      activeInteractionSession = null;
      await client.detach().catch(() => { });
    } else {
      activeInteractionSession = null;
    }
  }
}

// 安全發送 Telegram 訊息（支援自動長度分段與降級防呆，相容 Context 物件與純 chatId）
async function sendSafeTelegramMessage(target, text) {
  const MAX_CHUNK_LENGTH = 3500; // 避免超過 Telegram 4096 限制
  const isChatId = typeof target === 'string' || typeof target === 'number';
  const send = async (msg, extra) => {
    if (isChatId) {
      return bot.telegram.sendMessage(target, msg, extra);
    }
    return target.reply(msg, extra);
  };

  if (!text || text.trim().length === 0) {
    return send('（回覆內容為空）');
  }

  // 若文字小於上限，直接發送
  if (text.length <= MAX_CHUNK_LENGTH) {
    try {
      return await send(text, { parse_mode: 'Markdown' });
    } catch {
      return await send(text); // Markdown 解析失敗時降級為純文字
    }
  }

  // 超出上限時分段發送
  for (let i = 0; i < text.length; i += MAX_CHUNK_LENGTH) {
    const chunk = text.slice(i, i + MAX_CHUNK_LENGTH);
    try {
      await send(chunk, { parse_mode: 'Markdown' });
    } catch {
      await send(chunk);
    }
    // 短暫間隔避免觸發 Telegram Rate Limit
    await new Promise(r => setTimeout(r, 300));
  }
}

// --- Antigravity 即時動作追蹤 (基於 transcript.jsonl 磁碟日誌監聽，支援最近 3 步軌跡) ---

function formatToolAction(tc) {
  if (!tc || !tc.name) return '🧠 思考分析';
  const name = tc.name;
  const args = tc.args || {};

  const clean = (val) => {
    if (!val) return '';
    let str = typeof val === 'string' ? val : JSON.stringify(val);
    str = str.replace(/^[\"']|[\"']$/g, '').trim();
    str = str.replace(/\\"/g, '"');
    return str;
  };

  switch (name) {
    case 'run_command': {
      const summary = clean(args.toolSummary);
      const cmd = clean(args.CommandLine);
      if (summary) return '⚙️ [指令] ' + (summary.length > 38 ? summary.slice(0, 35) + '...' : summary);
      if (cmd) {
        const shortCmd = cmd.length > 38 ? cmd.slice(0, 35) + '...' : cmd;
        return '⚙️ [指令] ' + shortCmd;
      }
      return '⚙️ [指令] 執行終端指令';
    }
    case 'read_file': {
      const p = clean(args.Path);
      const base = p ? path.basename(p) : '檔案';
      return '📖 [讀檔] ' + base;
    }
    case 'edit_file': {
      const p = clean(args.Path);
      const base = p ? path.basename(p) : '檔案';
      return '📝 [修改] ' + base;
    }
    case 'write_file': {
      const p = clean(args.Path);
      const base = p ? path.basename(p) : '檔案';
      return '📄 [建立] ' + base;
    }
    case 'search_web': {
      const q = clean(args.query);
      const shortQ = q.length > 30 ? q.slice(0, 27) + '...' : q;
      return '🔍 [搜尋] ' + shortQ;
    }
    case 'ask_question': {
      return '❓ [提問] 等待確認選擇';
    }
    case 'invoke_subagent': {
      const role = clean(args.Role) || clean(args.TypeName) || '子代理';
      return '🤖 [代理] ' + role;
    }
    default: {
      return '⚡ [工具] ' + name;
    }
  }
}

function getRecentAgentSteps(limit = 3) {
  try {
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    if (!fs.existsSync(brainDir)) return null;

    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    let latestFolder = null;
    let latestMtime = 0;
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const p = path.join(brainDir, ent.name);
        const mtime = fs.statSync(p).mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestFolder = p;
        }
      }
    }
    if (!latestFolder) return null;

    const logPath = path.join(latestFolder, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(logPath)) return null;

    const stat = fs.statSync(logPath);
    if (stat.size === 0) return null;

    const bufSize = Math.min(stat.size, 65536);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(bufSize);
    fs.readSync(fd, buf, 0, bufSize, Math.max(0, stat.size - bufSize));
    fs.closeSync(fd);

    const lines = buf.toString('utf8').trim().split('\n');
    const collectedSteps = [];
    let isCurrentlyThinking = false;
    let latestPlannerStepIndex = -1;
    let latestGenericStepIndex = -1;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (latestGenericStepIndex === -1 && item.type === 'GENERIC') {
          latestGenericStepIndex = item.step_index || 0;
        }

        if (item.type === 'PLANNER_RESPONSE') {
          if (latestPlannerStepIndex === -1) {
            latestPlannerStepIndex = item.step_index || 0;
          }
          if (item.tool_calls && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
            for (let t = item.tool_calls.length - 1; t >= 0; t--) {
              collectedSteps.unshift(formatToolAction(item.tool_calls[t]));
              if (collectedSteps.length >= limit) break;
            }
          }
        }
        if (collectedSteps.length >= limit) break;
      } catch (e) {}
    }

    if (latestGenericStepIndex > latestPlannerStepIndex || collectedSteps.length === 0) {
      isCurrentlyThinking = true;
    }

    return {
      steps: collectedSteps,
      isThinking: isCurrentlyThinking
    };
  } catch (err) {
    return null;
  }
}

function formatStepsProgress(info) {
  if (!info || (!info.steps || !info.steps.length)) {
    return '🧠 正在思考整體方案...';
  }

  const numIcons = ['1️⃣', '2️⃣', '3️⃣'];
  let lines = [];
  if (info.steps && info.steps.length > 0) {
    info.steps.forEach((step, idx) => {
      const icon = numIcons[idx] || (idx + 1) + '.';
      lines.push(icon + ' ' + step);
    });
  }

  if (info.isThinking) {
    if (lines.length > 0) {
      lines.push('➡️ 🧠 正在分析結果並規劃下一步...');
    } else {
      lines.push('🧠 正在思考整體方案...');
    }
  } else if (lines.length > 0) {
    lines[lines.length - 1] += ' (執行中)';
  }

  return lines.join('\n');
}

function getLatestAgentAction() {
  const info = getRecentAgentSteps(1);
  if (!info) return null;
  if (info.steps && info.steps.length > 0) {
    return info.steps[0] + (info.isThinking ? ' (分析下一步中)' : ' (執行中)');
  }
  return '🧠 正在分析與思考中...';
}

// 停止 / 暫停目前正在執行的任務（點擊 Cancel/Stop 按鈕）
async function stopAntigravityExecution() {
  const target = await waitForAntigravityTarget(3, 800);
  if (!target) {
    throw new Error('未連線到 Antigravity 面板，無法執行暫停。');
  }

  let client = null;
  try {
    client = await target.createCDPSession();
    const evalRes = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const cancelOrStopBtn = document.querySelector('button[aria-label*="Cancel"], button[aria-label*="Stop"], button[title*="Cancel"], button[title*="Stop"]');
        if (cancelOrStopBtn) {
          cancelOrStopBtn.click();
          return { success: true, label: cancelOrStopBtn.getAttribute('aria-label') || cancelOrStopBtn.innerText };
        }
        return { success: false, reason: 'not_running' };
      })()`,
      returnByValue: true
    });
    return evalRes?.result?.value || { success: false, reason: 'unknown' };
  } finally {
    if (client) {
      await client.detach().catch(() => { });
    }
  }
}

// 開啟新的對話 Session（點擊 New Conversation 按鈕）
async function createNewAntigravitySession() {
  const target = await waitForAntigravityTarget(3, 800);
  if (!target) {
    throw new Error('未連線到 Antigravity 面板，無法建立新 Session。');
  }

  const client = await target.createCDPSession();
  try {
    const evalRes = await client.send('Runtime.evaluate', {
      expression: `(() => {
        // 優先搜尋全域 New Conversation 按鈕（包含 extension-new-conversation 與 new-conversation-button）
        const newBtn = document.querySelector('[data-testid*="new-conversation"], button[data-testid*="new-conversation"], button[aria-label*="New Conversation"], button[title*="New Conversation"]');
        if (newBtn) {
          newBtn.click();
          return { success: true, method: 'new_conversation_button' };
        }

        // 次要搜尋專案內的 New Conversation 按鈕
        const projBtn = document.querySelector('button[aria-label="New Conversation in Project"]');
        if (projBtn) {
          projBtn.click();
          return { success: true, method: 'new_conversation_in_project' };
        }

        return { success: false, reason: 'button_not_found' };
      })()`,
      returnByValue: true
    });
    return evalRes?.result?.value || { success: false, reason: 'unknown' };
  } finally {
    await client.detach().catch(() => { });
  }
}

// --- 模型與用量專用處理常式 (支援一般訊息與 Inline Button 共用) ---

async function executeUsageQuery(chatId) {
  const noticeMsg = await bot.telegram.sendMessage(chatId, '🔍 正在向 Antigravity 讀取模型用量配額...');
  try {
    const data = await getAntigravityModels({ includeUsage: true });
    if (!data || !data.success || !data.usage) {
      return bot.telegram.editMessageText(
        chatId,
        noticeMsg.message_id,
        null,
        `⚠️ 未能獲取用量資訊，請確認 Antigravity 側邊欄是否正常。`
      );
    }

    const u = data.usage;
    const g = u.gemini || {};
    const c = u.claudeGpt || {};
    const a = u.argon || {};

    let argonSection = '';
    if (a.weeklyRemaining) {
      argonSection = `🔹 *Gemini 4 Argon*\n` +
        `• 每週剩餘：\`${a.weeklyRemaining}\`${a.weeklyRefresh ? ` (重置: ${a.weeklyRefresh})` : ''}\n\n`;
    }

    let msg = `📊 *Antigravity 模型配額與使用量*\n\n` +
      `🎖️ *帳號方案*：\`${u.plan || '未知'}\`\n\n` +
      `🔹 *Gemini Models*\n` +
      `• 每週剩餘：\`${g.weeklyRemaining || 'N/A'}\`${g.weeklyRefresh ? ` (重置: ${g.weeklyRefresh})` : ''}\n` +
      `• 5小時剩餘：\`${g.fiveHourRemaining || 'N/A'}\`${g.fiveHourRefresh ? ` (重置: ${g.fiveHourRefresh})` : ''}\n\n` +
      `🔹 *Claude & GPT Models*\n` +
      `• 每週剩餘：\`${c.weeklyRemaining || 'N/A'}\`${c.weeklyRefresh ? ` (重置: ${c.weeklyRefresh})` : ''}\n` +
      `• 5小時剩餘：\`${c.fiveHourRemaining || 'N/A'}\`${c.fiveHourRefresh ? ` (重置: ${c.fiveHourRefresh})` : ''}\n\n` +
      argonSection +
      `📌 *當前啟用模型*：\`${data.currentModel?.raw || '未知'}\``;

    return bot.telegram.editMessageText(
      chatId,
      noticeMsg.message_id,
      null,
      msg,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    return bot.telegram.editMessageText(
      chatId,
      noticeMsg.message_id,
      null,
      `❌ 讀取用量失敗: ${err.message}`
    );
  }
}

async function executeModelsListQuery(chatId) {
  const noticeMsg = await bot.telegram.sendMessage(chatId, '🔍 正在向 Antigravity 讀取可用模型清單...');
  try {
    const data = await getAntigravityModels({ includeUsage: false });
    if (!data || !data.success) {
      return bot.telegram.editMessageText(
        chatId,
        noticeMsg.message_id,
        null,
        `⚠️ 讀取模型失敗: ${data?.reason || '未知錯誤'}`
      );
    }

    let msg = `🤖 *Antigravity 模型清單*\n\n` +
      `📌 *當前使用*：\`${data.currentModel?.raw || '未知'}\`\n\n` +
      `📋 *可選模型列表*：\n`;

    const keyboardButtons = [];

    data.models.forEach((m, idx) => {
      const isCur = m.isSelected;
      const mark = isCur ? '👉 ' : '   ';
      const effortStr = m.effort ? ` _(${m.effort})_` : '';
      const badgeStr = m.badges && m.badges.length > 0 ? ` \`[${m.badges.join(', ')}]\`` : '';
      msg += `${mark}\`${idx + 1}.\` *${m.name}*${effortStr}${badgeStr}\n`;

      const shortName = m.name.replace(/^(Gemini|Claude|GPT-OSS)\s*/i, '');
      const btnLabel = `${isCur ? '✅ ' : ''}${idx + 1}. ${shortName}`;
      keyboardButtons.push({ text: btnLabel, callback_data: `switch_model:${idx + 1}` });
    });

    msg += `\n💡 *切換方式*：請直接點擊下方按鈕切換模型：`;

    const inlineKeyboard = [];
    for (let i = 0; i < keyboardButtons.length; i += 2) {
      inlineKeyboard.push(keyboardButtons.slice(i, i + 2));
    }
    inlineKeyboard.push([{ text: '📊 查看用量配額 (/usage)', callback_data: 'view_usage' }]);

    return bot.telegram.editMessageText(
      chatId,
      noticeMsg.message_id,
      null,
      msg,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
      }
    );
  } catch (err) {
    return bot.telegram.editMessageText(
      chatId,
      noticeMsg.message_id,
      null,
      `❌ 讀取模型清單失敗: ${err.message}`
    );
  }
}

async function executeModelSwitch(chatId, targetArg) {
  const noticeMsg = await bot.telegram.sendMessage(chatId, `🔄 正在切換模型為 "${targetArg}"...`);
  try {
    const res = await switchAntigravityModel(targetArg);
    if (!res.success) {
      let errMsg = `❌ 切換失敗: ${res.reason}`;
      if (res.available) {
        errMsg += `\n\n📋 *可選模型列表*：\n` + res.available.map(m => `• ${m}`).join('\n');
      }
      return bot.telegram.editMessageText(
        chatId,
        noticeMsg.message_id,
        null,
        errMsg,
        { parse_mode: 'Markdown' }
      );
    }

    if (!res.switched) {
      return bot.telegram.editMessageText(
        chatId,
        noticeMsg.message_id,
        null,
        `ℹ️ 目前已在使用此模型，無須變更。\n📌 *當前模型*：\`${res.currentModel}\``,
        { parse_mode: 'Markdown' }
      );
    }

    return bot.telegram.editMessageText(
      chatId,
      noticeMsg.message_id,
      null,
      `🎉 *模型切換成功！*\n\n變更前：\`${res.previousModel}\`\n變更後：\`${res.currentModel}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    return bot.telegram.editMessageText(
      chatId,
      noticeMsg.message_id,
      null,
      `❌ 切換模型失敗: ${err.message}`
    );
  }
}

// --- 工作區自定義技能核心處理常式 ---

// 執行技能專用處理常式 (透過 Telegram 按鈕或文字指令呼叫)
async function executeSkill(chatId, skill) {
  const safeSkillName = escapeMarkdown(skill.name);
  const safeProject = String(skill.project || '').replace(/`/g, "'");

  // 1. 防呆：檢查 Antigravity 是否正忙碌
  const busyCheck = await checkAntigravityBusy();
  if (busyCheck.isBusy) {
    return bot.telegram.sendMessage(
      chatId,
      `⏳ *無法啟動技能【${safeSkillName}】*\n\nAntigravity 當前正在執行其他任務中，請稍候再試或使用 \`/stop\` 中斷當前任務。`,
      { parse_mode: 'Markdown' }
    ).catch(() => {
      return bot.telegram.sendMessage(
        chatId,
        `⏳ 無法啟動技能【${skill.name}】：Antigravity 當前正在執行其他任務中，請稍候再試或使用 /stop 中斷當前任務。`
      );
    });
  }

  const cleanPrompt = (skill.prompt || '').length > 200 ? skill.prompt.slice(0, 197) + '...' : (skill.prompt || '');
  const safePrompt = escapeMarkdown(cleanPrompt.replace(/\r?\n+/g, ' '));

  const noticeMsg = await bot.telegram.sendMessage(
    chatId,
    `⚡ *正在啟動技能：【${safeSkillName}】*\n\n` +
    `📂 *專案*：\`${safeProject}\`\n` +
    `📝 *Prompt*：${safePrompt}\n\n` +
    `⏳ 正在投遞指令至 Antigravity 執行中...`,
    { parse_mode: 'Markdown' }
  ).catch(() => {
    return bot.telegram.sendMessage(
      chatId,
      `⚡ 正在啟動技能：【${skill.name}】\n\n📂 專案：${skill.project}\n📝 Prompt：${cleanPrompt}\n\n⏳ 正在投遞指令至 Antigravity 執行中...`
    );
  });

  let elapsedSec = 0;
  await bot.telegram.sendChatAction(chatId, 'typing').catch(() => { });
  const heartbeatTimer = setInterval(async () => {
    elapsedSec += 4;
    try {
      await bot.telegram.sendChatAction(chatId, 'typing');
      if (elapsedSec % 12 === 0) {
        await bot.telegram.editMessageText(
          chatId,
          noticeMsg.message_id,
          null,
          `⏳ 技能【${skill.name}】執行中（已耗時 ${elapsedSec} 秒）...`
        );
      }
    } catch {
      // 忽略暫時性網路波動
    }
  }, 4000);

  try {
    const { replyText } = await sendAndAwaitAntigravityReply(skill.prompt, null, chatId);
    clearInterval(heartbeatTimer);

    try {
      await bot.telegram.editMessageText(
        chatId,
        noticeMsg.message_id,
        null,
        `✅ *技能【${safeSkillName}】執行完成！*（耗時 ${elapsedSec} 秒）`,
        { parse_mode: 'Markdown' }
      );
    } catch {
      await bot.telegram.editMessageText(
        chatId,
        noticeMsg.message_id,
        null,
        `✅ 技能【${skill.name}】執行完成！（耗時 ${elapsedSec} 秒）`
      ).catch(() => { });
    }

    await sendSafeTelegramMessage(chatId, replyText);
  } catch (err) {
    clearInterval(heartbeatTimer);
    console.error(`[技能執行錯誤] 【${skill.name}】:`, err);
    const safeErrMsg = escapeMarkdown(err.message);
    try {
      await bot.telegram.editMessageText(
        chatId,
        noticeMsg.message_id,
        null,
        `❌ *技能【${safeSkillName}】執行失敗！*\n\n原因: ${safeErrMsg}`,
        { parse_mode: 'Markdown' }
      );
    } catch {
      await bot.telegram.sendMessage(
        chatId,
        `❌ 技能【${skill.name}】執行失敗！\n\n原因: ${err.message}`
      ).catch(() => { });
    }
  }
}


// 執行 Antigravity Takeover 互動卡片的選項點擊與自動送出
async function executeTakeoverAction(client, rawVal) {
  try {
    const res = await client.send('Runtime.evaluate', {
      expression: `(async (val) => {
        const card = document.querySelector('[data-testid="interaction-takeover-card"]');
        if (!card) return { success: false, reason: '互動卡片已關閉或已完成' };

        if (val === 'skip') {
          const skipBtn = card.querySelector('[data-testid="interaction-skip-button"]');
          if (skipBtn) {
            skipBtn.click();
            return { success: true, text: '略過 (Skip)' };
          }
          return { success: false, reason: '找不到 Skip 按鈕' };
        }

        // 選中指定 radio / label
        const radio = card.querySelector('input[type="radio"][value="' + val + '"]');
        let optionLabelText = '已選擇';
        if (radio) {
          radio.click();
          radio.checked = true;
          radio.dispatchEvent(new Event('input', { bubbles: true }));
          radio.dispatchEvent(new Event('change', { bubbles: true }));
          const label = radio.closest('label');
          if (label) {
            label.click();
            optionLabelText = label.innerText.replace(/\s+/g, ' ').trim();
          }
        }

        // 等待 150ms 確保 DOM 反應後點擊 Submit
        await new Promise(r => setTimeout(r, 150));
        const submitBtn = card.querySelector('[data-testid="interaction-continue-button"]');
        if (submitBtn) {
          submitBtn.click();
          return { success: true, text: optionLabelText };
        }
        return { success: false, reason: '找不到 Submit 按鈕' };
      })(${JSON.stringify(rawVal)})`,
      awaitPromise: true,
      returnByValue: true
    });
    return res?.result?.value || { success: false, reason: 'CDP 無回傳' };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// --- 動態排程任務核心處理常式 ---

// 檢查 Antigravity 當前是否正忙碌中
async function checkAntigravityBusy() {
  const target = await waitForAntigravityTarget(2, 600);
  if (!target) return { connected: false, isBusy: false };
  const client = await target.createCDPSession();
  try {
    const checkRes = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const cancelOrStopBtn = document.querySelector('button[aria-label*="Cancel"], button[aria-label*="Stop"], button[title*="Cancel"], button[title*="Stop"]');
        return { isBusy: !!cancelOrStopBtn };
      })()`,
      returnByValue: true
    });
    return { connected: true, isBusy: !!checkRes?.result?.value?.isBusy };
  } catch {
    return { connected: true, isBusy: false };
  } finally {
    await client.detach().catch(() => { });
  }
}

// 執行排程任務核心流程（定時觸發或手動觸發）
async function executeScheduledTask(task, isManual = false) {
  const triggerType = isManual ? '手動觸發' : '排程觸發';
  console.log(`[排程任務啟動] 【${task.name}】(${triggerType}) - ID: ${task.id}`);

  // 防呆：若 Antigravity 正忙碌，等待重試
  for (let retry = 0; retry < 3; retry++) {
    const busyCheck = await checkAntigravityBusy();
    if (!busyCheck.isBusy) break;

    console.warn(`[排程等待] 偵測到 Antigravity 正忙碌中，等待 20 秒後重試 (${retry + 1}/3)...`);
    await bot.telegram.sendMessage(
      allowedId,
      `⏳ *【${task.name}】* 觸發，但 Antigravity 當前正在執行其他任務，將等待 20 秒後重試 (${retry + 1}/3)...`,
      { parse_mode: 'Markdown' }
    ).catch(() => { });
    await new Promise(r => setTimeout(r, 20000));
  }

  // 發送任務啟動通知
  const startMsg = await bot.telegram.sendMessage(
    allowedId,
    `⏰ *${triggerType}：【${task.name}】*\n\n` +
    `📝 *Prompt*：\`${task.prompt}\`\n\n` +
    `⏳ 正在喚醒 Antigravity 執行任務中...`,
    { parse_mode: 'Markdown' }
  ).catch(err => {
    console.warn('[排程推播警告] 無法發送起始通知:', err.message);
    return null;
  });

  try {
    // 1. 若啟用 newSession，先建立乾淨的新對話
    if (task.newSession !== false) {
      try {
        console.log(`[排程執行] 為任務 【${task.name}】 建立新對話 Session...`);
        await createNewAntigravitySession();
        await new Promise(r => setTimeout(r, 1200));
      } catch (err) {
        console.warn(`[排程警告] 開啟新 Session 失敗，繼續在當前對話執行: ${err.message}`);
      }
    }

    // 2. 投遞指令至 Antigravity 並等待執行完成
    const { replyText } = await sendAndAwaitAntigravityReply(task.prompt);

    // 3. 更新啟動通知為已完成
    if (startMsg) {
      await bot.telegram.editMessageText(
        allowedId,
        startMsg.message_id,
        null,
        `✅ *${triggerType}：【${task.name}】執行完成！*`,
        { parse_mode: 'Markdown' }
      ).catch(() => { });
    }

    // 4. 將完整回覆推播給使用者
    await sendSafeTelegramMessage(allowedId, replyText);

  } catch (err) {
    console.error(`[排程執行錯誤] 任務 【${task.name}】 失敗:`, err);
    if (startMsg) {
      await bot.telegram.editMessageText(
        allowedId,
        startMsg.message_id,
        null,
        `❌ *${triggerType}：【${task.name}】執行失敗！*\n\n原因: ${err.message}`,
        { parse_mode: 'Markdown' }
      ).catch(() => { });
    } else {
      await bot.telegram.sendMessage(
        allowedId,
        `❌ *${triggerType}：【${task.name}】執行失敗！*\n\n原因: ${err.message}`,
        { parse_mode: 'Markdown' }
      ).catch(() => { });
    }
    throw err;
  }
}

// 格式化輸出排程清單與 Inline Keyboard 按鈕
function renderTasksMessage() {
  const tasks = scheduler.getTaskList();
  if (tasks.length === 0) {
    return {
      text: `📋 *目前無任何排程任務*\n\n` +
        `💡 *自然語言快速建立排程*：\n` +
        `直接輸入指令，例如：\n` +
        `\`/schedule 每個工作日18:00幫我分析台股籌碼重點\``,
      buttons: [[{ text: '➕ 如何使用自然語言排程', callback_data: 'task_add_help' }]]
    };
  }

  let text = `⏰ *Antigravity 動態排程任務清單* (時區: \`${DEFAULT_TIMEZONE}\`)\n\n`;
  const keyboardButtons = [];

  tasks.forEach((t, idx) => {
    const statusIcon = t.enabled ? '🟢' : '⏸️';
    const statusText = t.enabled ? '啟用中' : '已停用';
    const nextRunStr = t.enabled && t.nextRun ? `\n   ↳ ⏰ *下次執行*：\`${t.nextRun}\`` : '';
    const lastRunStr = t.lastRunAt ? `\n   ↳ 🕒 *上次執行*：\`${new Date(t.lastRunAt).toLocaleString('zh-TW', { timeZone: DEFAULT_TIMEZONE, hour12: false })}\` (${t.lastStatus || '無狀態'})` : '';

    text += `${statusIcon} *${idx + 1}. ${t.name}*\n` +
      `   • 🆔 ID: \`${t.id}\`\n` +
      `   • ⏱️ Cron: \`${t.cron}\` (${statusText})${nextRunStr}${lastRunStr}\n` +
      `   • 📝 Prompt: \`${t.prompt.length > 30 ? t.prompt.slice(0, 30) + '...' : t.prompt}\`\n\n`;

    // 每個任務專屬按鈕（第一列：立即執行；第二列：啟用/停用 + 刪除）
    keyboardButtons.push([
      { text: `▶️ 立即執行 #${idx + 1}`, callback_data: `task_run:${t.id}` },
      { text: t.enabled ? '⏸️ 停用' : '🟢 啟用', callback_data: `task_toggle:${t.id}` },
      { text: '🗑️ 刪除', callback_data: `task_del:${t.id}` }
    ]);
  });

  text += `💡 *操作提示*：\n` +
    `• 點擊上方按鈕可即時測跑、切換或刪除任務。\n` +
    `• 輸入 \`/schedule <自然語言需求>\` 可隨時建立新排程。\n` +
    `• 本機編輯 \`schedules.json\` 存檔後自動熱重載 (Hot-reload)。`;

  keyboardButtons.push([
    { text: '🔄 重新整理清單', callback_data: 'task_refresh' },
    { text: '➕ 如何建立排程說明', callback_data: 'task_add_help' }
  ]);

  return { text, buttons: keyboardButtons };
}

// 透過 Antigravity LLM 進行深度語意轉譯（當本地規則無法解析時）
async function parseScheduleWithLLM(userInput) {
  const prompt = `請將以下自然語言需求解析為定時排程的 JSON 格式。
請以台北時間（Asia/Taipei）為標準。
請嚴格只輸出純 JSON 物件，絕對不要包含任何 Markdown 格式標籤（不要包含 \`\`\`json 或 \`\`\`），不要輸出任何解釋文字：
{"name": "簡短任務名稱(15字內)", "cron": "標準5欄位Cron表達式(分 時 日 月 週)", "prompt": "執行提示詞"}

使用者需求："${userInput.replace(/"/g, '\\"')}"`;

  const { replyText } = await sendAndAwaitAntigravityReply(prompt);
  const jsonMatch = replyText.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    throw new Error('LLM 回傳未能提取到有效 JSON');
  }
  const parsed = JSON.parse(jsonMatch[0]);
  const cron = require('node-cron');
  if (!parsed.cron || !cron.validate(parsed.cron.trim())) {
    throw new Error('LLM 解析出的 Cron 表達式無效: ' + (parsed.cron || '空'));
  }
  return {
    name: (parsed.name || '智慧排程任務').trim(),
    cron: parsed.cron.trim(),
    prompt: (parsed.prompt || userInput).trim(),
    source: 'llm'
  };
}

// 格式化輸出排程確認卡片與按鈕
function renderScheduleConfirmCard(parsed, isFast, confirmId) {
  const nextRunStr = calculateNextRun(parsed.cron) || '無效時間';
  const engineDesc = isFast ? '⚡ 本地智慧規則 (0秒即時)' : '🧠 Antigravity LLM 深度轉譯';

  const cardText = `🤖 *已為您解析排程需求如下*：\n\n` +
    `📌 *任務名稱*：${parsed.name}\n` +
    `⏰ *執行時機*：\`${parsed.cron}\`\n` +
    `🕒 *下次預計執行*：\`${nextRunStr}\`\n` +
    `📝 *執行指令*：\`${parsed.prompt}\`\n\n` +
    `_(解析引擎: ${engineDesc})_\n\n` +
    `請問是否確認將此排程加入系統？`;

  const buttons = isFast ? [
    [
      { text: '✅ 確認加入排程', callback_data: `task_confirm:${confirmId}` },
      { text: '🧠 讓 LLM 重新解析', callback_data: `task_llm:${confirmId}` }
    ],
    [
      { text: '❌ 取消', callback_data: `task_cancel:${confirmId}` }
    ]
  ] : [
    [
      { text: '✅ 確認加入排程', callback_data: `task_confirm:${confirmId}` },
      { text: '❌ 取消', callback_data: `task_cancel:${confirmId}` }
    ]
  ];

  return { text: cardText, buttons };
}

// 處理自然語言排程建立流程（雙軌解析 + Telegram 確認卡片）
async function handleNaturalLanguageSchedule(ctx, inputPrompt) {
  if (!inputPrompt || inputPrompt.trim().length === 0) {
    return ctx.reply(
      `⏰ *自然語言排程建立教學*\n\n` +
      `請直接輸入您想要的執行時機與任務內容，例如：\n\n` +
      `• \`/schedule 每個工作日晚上6點幫我執行台股籌碼爬蟲並分析重點\`\n` +
      `• \`/schedule 每天早上 8:30 整理美股開盤前要聞\`\n` +
      `• \`/schedule 每隔 2 小時檢查專案後台運行狀態\`\n` +
      `• \`/schedule 每週日晚上 9 點產出週報\`\n\n` +
      `💡 系統將自動為您解析出執行時機與任務，並彈出【確認按鈕】讓您一鍵加入！`,
      { parse_mode: 'Markdown' }
    );
  }

  const noticeMsg = await ctx.reply('🔍 正在智慧解析您的排程需求...');

  let parsed = parseScheduleFast(inputPrompt);
  let isFast = true;

  if (!parsed) {
    isFast = false;
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        noticeMsg.message_id,
        null,
        '🧠 正在請求 Antigravity LLM 深度理解排程語意中...'
      );
      parsed = await parseScheduleWithLLM(inputPrompt);
    } catch (err) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        noticeMsg.message_id,
        null,
        `❌ 無法解析排程需求：${err.message}\n\n請嘗試包含具體時間，例如「每個工作日 18:00 執行...」`
      );
    }
  }

  const confirmId = 'cf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  pendingSchedules.set(confirmId, {
    ...parsed,
    rawInput: inputPrompt
  });

  // 10 分鐘後自動過期清理
  setTimeout(() => {
    pendingSchedules.delete(confirmId);
  }, 10 * 60 * 1000);

  const { text: cardText, buttons } = renderScheduleConfirmCard(parsed, isFast, confirmId);

  return ctx.telegram.editMessageText(
    ctx.chat.id,
    noticeMsg.message_id,
    null,
    cardText,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    }
  );
}

// 處理使用者訊息的核心流程（獨立非同步執行，不阻塞 Telegraf Polling）
// 待處理圖片緩衝池（處理手機先傳圖、隨後秒打字的使用情境）
const pendingImageBuffer = new Map(); // userId -> { ctx, localFilePath, noticeMsg, timeoutId }

async function handleUserRequest(ctx) {
  const rawText = ctx.message.text ? ctx.message.text.trim() : '';

  // 檢查是否有待合併的圖片（處理先發圖片、緊接著打字補充說明的情境）
  const userId = ctx.from.id;
  if (pendingImageBuffer.has(userId) && !rawText.startsWith('/')) {
    const pending = pendingImageBuffer.get(userId);
    clearTimeout(pending.timeoutId);
    pendingImageBuffer.delete(userId);

    console.log(`[圖文合併成功] 收到隨後補充文字：「${rawText}」，與剛才圖片合併派發！`);
    await pending.ctx.telegram.editMessageText(
      pending.ctx.chat.id,
      pending.noticeMsg.message_id,
      null,
      `📥 已將圖片與您的文字說明合併，正在轉發至 Antigravity...`
    ).catch(() => {});

    return dispatchImagePrompt(ctx, pending.localFilePath, rawText, pending.noticeMsg);
  }
  const lowerText = rawText.toLowerCase();

  // 1. 指令：暫停 / 中斷當前執行
  if (['/stop', '/cancel', 'stop', 'cancel', '暫停', '停止', '/中斷'].includes(lowerText)) {
    const noticeMsg = await ctx.reply('🛑 正在為您發送中斷訊號至 Antigravity...');
    try {
      const res = await stopAntigravityExecution();
      if (res.success) {
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          noticeMsg.message_id,
          null,
          `🛑 已成功點擊 Cancel 按鈕，中斷 Antigravity 當前執行！`
        );
      } else {
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          noticeMsg.message_id,
          null,
          `ℹ️ 目前 Antigravity 處於閒置狀態，無正在執行的任務需要暫停。`
        );
      }
    } catch (err) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        noticeMsg.message_id,
        null,
        `❌ 暫停失敗: ${err.message}`
      );
    }
  }

  // 2. 指令：開啟新的對話 Session
  if (['/new', '/reset', 'new', 'reset', '開新對話', '新對話', '/新對話'].includes(lowerText)) {
    const noticeMsg = await ctx.reply('✨ 正在點擊按鈕開啟新的 Antigravity Session...');
    try {
      const res = await createNewAntigravitySession();
      if (res.success) {
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          noticeMsg.message_id,
          null,
          `🎉 已成功點擊按鈕開啟新的對話 Session！現在您可以開始全新的任務。`
        );
      } else {
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          noticeMsg.message_id,
          null,
          `⚠️ 未能找到 New Conversation 按鈕，請確認側邊欄介面是否已展開。`
        );
      }
    } catch (err) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        noticeMsg.message_id,
        null,
        `❌ 開啟新 Session 失敗: ${err.message}`
      );
    }
  }

  // 2.5 指令：即時視窗截圖 (/screenshot, /截圖)
  if (['/screenshot', '/截圖', 'screenshot', '截圖'].includes(lowerText)) {
    const noticeMsg = await ctx.reply('📸 正在擷取 Antigravity 視窗畫面...');
    let client = null;
    try {
      const b = await getBrowser();
      const targets = b.targets();
      // 截圖必須在 Top-level Target (type === 'page') 執行，若對 webview iframe 執行會拋錯
      const pageTarget = targets.find(t => t.type() === 'page') || (await waitForAntigravityTarget(3, 1000));
      if (!pageTarget) throw new Error('未找到可截圖的視窗 Target');

      client = await pageTarget.createCDPSession();
      const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
      const buffer = Buffer.from(screenshot.data, 'base64');
      await ctx.replyWithPhoto({ source: buffer }, { caption: `📸 [${targetProject}] 當前視窗截圖` });
      return ctx.telegram.deleteMessage(ctx.chat.id, noticeMsg.message_id).catch(() => {});
    } catch (err) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        noticeMsg.message_id,
        null,
        `❌ 截圖失敗: ${err.message}`
      );
    } finally {
      if (client) {
        await client.detach().catch(() => {});
      }
    }
  }

  // 3. 指令：手動狀態檢查
  if (['/status', 'status', '/狀態'].includes(lowerText)) {
    const statusMsg = await ctx.reply('🔍 正在確認本機 Antigravity 連線狀態...');
    const target = await waitForAntigravityTarget(3, 1000);
    if (target) {
      let client = null;
      try {
        client = await target.createCDPSession();
        const checkRes = await client.send('Runtime.evaluate', {
          expression: `(() => {
            const cancelOrStopBtn = document.querySelector('button[aria-label*="Cancel"], button[aria-label*="Stop"], button[title*="Cancel"], button[title*="Stop"]');
            return { isBusy: !!cancelOrStopBtn };
          })()`,
          returnByValue: true
        });
        const isBusy = checkRes?.result?.value?.isBusy;
        let statusText = `🟢 [${targetProject}] 本機連線正常！\n\n📌 面板狀態：${isBusy ? '⚡ 正在執行任務中' : '💤 閒置待命中'}`;
        if (isBusy) {
          const currentAct = getLatestAgentAction();
          if (currentAct) {
            statusText += `\n📌 當前動作：${currentAct}`;
          }
        }

        return ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          statusText
        );
      } catch {
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `🟢 [${targetProject}] 本機連線正常，Antigravity 面板就緒！`
        );
      } finally {
        if (client) {
          await client.detach().catch(() => { });
        }
      }
    } else {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `🔴 未找到 Antigravity，請確認電腦端側邊欄是否已展開。`
      );
    }
  }

  // 4. 指令：查看用量配額 (/usage)
  if (['/usage', 'usage', '用量', '/用量', '/配額', '配額'].includes(lowerText)) {
    return executeUsageQuery(ctx.chat.id);
  }

  // 5. 指令：查看模型清單 (/models)
  if (['/models', 'models', '模型', '/模型'].includes(lowerText)) {
    return executeModelsListQuery(ctx.chat.id);
  }

  // 6. 指令：查看動態排程清單 (/tasks, /schedules)
  if (['/tasks', '/schedules', 'tasks', 'schedules'].includes(lowerText)) {
    const { text: msgText, buttons } = renderTasksMessage();
    return ctx.reply(msgText, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  }

  // 7. 指令：自然語言排程建立 (/schedule, /排程)
  if (rawText.startsWith('/schedule') || rawText.startsWith('/排程')) {
    const inputPrompt = rawText.replace(/^\/(schedule|排程)\s*/i, '').trim();
    if (!inputPrompt) {
      // 若只輸入 /schedule 或 /排程，則直接顯示排程清單
      const { text: msgText, buttons } = renderTasksMessage();
      return ctx.reply(msgText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      });
    }
    return handleNaturalLanguageSchedule(ctx, inputPrompt);
  }

  // 8. 指令：查看工作區自定義技能清單或直接執行 (/skills, /skill, /技能)
  if (rawText.startsWith('/skills') || rawText.startsWith('/skill') || rawText.startsWith('/技能') || ['skills', 'skill', '技能'].includes(lowerText)) {
    const skills = getWorkspaceSkills();
    const arg = rawText.replace(/^\/(skills|skill|技能)\s*/i, '').trim();

    if (arg) {
      let targetSkill = null;
      const num = parseInt(arg, 10);
      if (!isNaN(num) && num >= 1 && num <= skills.length) {
        targetSkill = skills[num - 1];
      } else {
        targetSkill = skills.find(s => s.name.toLowerCase() === arg.toLowerCase() || s.id.toLowerCase() === arg.toLowerCase()) ||
          skills.find(s => s.name.toLowerCase().includes(arg.toLowerCase()));
      }

      if (targetSkill) {
        return executeSkill(ctx.chat.id, targetSkill);
      } else {
        return ctx.reply(`❌ 找不到符合「${arg}」的技能。請輸入 \`/skills\` 查看所有可用技能。`);
      }
    }

    const { text: msgText, buttons } = renderSkillsMessage(skills, targetProject);
    return ctx.reply(msgText, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    }).catch(err => {
      console.warn('[Skills] 發送 Markdown 格式失敗，降級為純文字發送:', err.message);
      return ctx.reply(msgText.replace(/[*_`\\]/g, ''), {
        reply_markup: { inline_keyboard: buttons }
      });
    });
  }

  // 9. 指令：幫助與說明
  if (['/help', '/start', 'help'].includes(lowerText)) {
    return ctx.reply(
      `🤖 *VS Code Antigravity Telegram Bridge 指令說明*\n\n` +
      `📌 *核心控制*：\n` +
      `• \`/skills\`：查看工作區自定義技能清單並支援按鈕一鍵執行\n` +
      `• \`/schedule <需求>\`：自然語言一句話建立排程\n` +
      `  _(例：\`/schedule 每個工作日18:00幫我分析台股籌碼\`_\n` +
      `• \`/tasks\`：查看排程清單 (支援按鈕測跑/啟用/停用/刪除)\n` +
      `• \`/models\`：查看可用模型清單與按鈕快速切換\n` +
      `• \`/usage\`：查看當前帳號額度與配額使用量\n` +
      `• \`/new\` 或 \`新對話\`：點擊開啟新的對話 Session\n` +
      `• \`/stop\` 或 \`暫停\`：中斷 / 暫停 Antigravity 當前執行\n` +
      `• \`/status\`：檢查 Antigravity 當前連線與工作狀態\n` +
      `• \`/help\`：顯示本說明\n\n` +
      `💬 *一般對話*：直接輸入任意文字即可發送給 Antigravity，完成後將自動推播回覆！`,
      { parse_mode: 'Markdown' }
    );
  }

  // 忽略未定義的其他斜線指令
  if (rawText.startsWith('/')) {
    return ctx.reply('❓ 未知的指令。可輸入 `/help` 查看支援的指令列表。');
  }

  const text = rawText;

  const dispatchMsg = await ctx.reply(`🛰️ 正在投遞指令至 [${targetProject}]...`);

  // 立即發送 Telegram "typing" 狀態
  await ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => { });

  // 定時心跳：每 4 秒維持 typing 狀態，動作切換或每 12 秒動態更新 Telegram 動作提示
  let elapsedSec = 0;
  let lastActionText = '';
  let lastEditTime = 0;

  const updateProgressMessage = async (force = false) => {
    const now = Date.now();
    const stepsInfo = getRecentAgentSteps(3);
    const progressBlock = formatStepsProgress(stepsInfo);
    const actionChanged = progressBlock && progressBlock !== lastActionText;

    if (!force && !actionChanged && (now - lastEditTime < 12000)) {
      return;
    }
    if (now - lastEditTime < 3000) {
      return;
    }

    lastActionText = progressBlock || lastActionText;
    lastEditTime = now;

    let text = `⏳ *Antigravity 正在執行中*（已耗時 ${elapsedSec} 秒）\n\n`;
    text += `📌 *最近步驟軌跡*：\n` + lastActionText;

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        dispatchMsg.message_id,
        null,
        text,
        { parse_mode: 'Markdown' }
      );
    } catch {
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          dispatchMsg.message_id,
          null,
          text.replace(/[*_]/g, '')
        );
      } catch {}
    }
  };

  const heartbeatTimer = setInterval(async () => {
    elapsedSec += 4;
    await ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
    await updateProgressMessage(false);
  }, 4000);

  try {
    let hasUpdatedStatus = false;
    const { replyText } = await sendAndAwaitAntigravityReply(text, async (state) => {
      if (state === 'generating' && !hasUpdatedStatus) {
        hasUpdatedStatus = true;
        await updateProgressMessage(true);
      }
    }, ctx.chat.id);

    // 任務完成：清除定時心跳
    clearInterval(heartbeatTimer);

    // 更新完成訊息
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        dispatchMsg.message_id,
        null,
        `✅ Antigravity 回覆完成（耗時 ${elapsedSec} 秒）：`
      );
    } catch {
      // 忽略狀態編輯失敗
    }

    // 將 Antigravity 完整回覆推播給使用者
    await sendSafeTelegramMessage(ctx, replyText);

  } catch (err) {
    clearInterval(heartbeatTimer);
    console.error('執行出錯:', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      dispatchMsg.message_id,
      null,
      `❌ 執行失敗: ${err.message}`
    );
  }
}

// 監聽 Telegram 訊息（非同步派發，徹底消除 Telegraf 90000ms Timeout）

// 統一圖片任務派發函式
async function dispatchImagePrompt(ctx, localFilePath, caption, noticeMsg) {
  // 依使用者指示：若無文字說明則不預設多餘文字，忠實轉傳
  let promptText = '';
  if (caption) {
    promptText = `${caption}\n\n[圖片路徑]: ${localFilePath}`;
  } else {
    promptText = `[圖片路徑]: ${localFilePath}`;
  }

  // 發送 Telegram typing 狀態
  await ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => { });

  let elapsedSec = 0;
  let lastActionText = '';
  let lastEditTime = 0;

  const updateImgProgressMessage = async (force = false) => {
    const now = Date.now();
    const stepsInfo = getRecentAgentSteps(3);
    const progressBlock = formatStepsProgress(stepsInfo);
    const actionChanged = progressBlock && progressBlock !== lastActionText;

    if (!force && !actionChanged && (now - lastEditTime < 12000)) {
      return;
    }
    if (now - lastEditTime < 3000) {
      return;
    }

    lastActionText = progressBlock || lastActionText;
    lastEditTime = now;

    let text = `⏳ *Antigravity 正在分析圖片與執行中*（已耗時 ${elapsedSec} 秒）\n\n`;
    text += `📌 *最近步驟軌跡*：\n` + lastActionText;

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        noticeMsg.message_id,
        null,
        text,
        { parse_mode: 'Markdown' }
      );
    } catch {
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          noticeMsg.message_id,
          null,
          text.replace(/[*_]/g, '')
        );
      } catch {}
    }
  };

  const heartbeatTimer = setInterval(async () => {
    elapsedSec += 4;
    await ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
    await updateImgProgressMessage(false);
  }, 4000);

  let hasUpdatedStatus = false;
  const { replyText } = await sendAndAwaitAntigravityReply(promptText, async (state) => {
    if (state === 'generating' && !hasUpdatedStatus) {
      hasUpdatedStatus = true;
      await updateImgProgressMessage(true);
    }
  }, ctx.chat.id);

  clearInterval(heartbeatTimer);

  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      noticeMsg.message_id,
      null,
      `✅ Antigravity 分析完成（耗時 ${elapsedSec} 秒）：`
    );
  } catch { }

  await sendSafeTelegramMessage(ctx, replyText);
}

// 處理 Telegram 圖片訊息（多路徑 Caption 提取 ＋ 1.8 秒圖文合併緩衝）
async function handleUserPhotoRequest(ctx) {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.reply('未授權的使用者。');
  }

  const photos = ctx.message.photo;
  if (!photos || photos.length === 0) return;

  // 取得最高解析度圖片
  const bestPhoto = photos[photos.length - 1];
  const fileId = bestPhoto.file_id;

  // 多路徑強化 Caption 擷取（相容不同客戶端、轉發、Entities 與原始欄位）
  const caption = (
    ctx.message?.caption ||
    ctx.caption ||
    ctx.update?.message?.caption ||
    ctx.message?.text ||
    ctx.text ||
    ''
  ).trim();

  console.log('--- [收到圖片訊息除錯紀錄] ---');
  console.log('ctx.message.caption:', ctx.message?.caption);
  console.log('ctx.caption:', ctx.caption);
  console.log('ctx.message.text:', ctx.message?.text);
  console.log('ctx.message keys:', Object.keys(ctx.message || {}));
  console.log('解析後的最終 Caption:', caption);
  console.log('------------------------------');

  const tempDir = path.join(os.tmpdir(), 'antigravity_bridge', 'tg_images');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const fileName = `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`;
  const localFilePath = path.join(tempDir, fileName);

  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const res = await fetch(fileLink.href);
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(localFilePath, Buffer.from(arrayBuffer));

    // 情況 1：照片本身已內嵌 Caption，立即直接派發
    if (caption) {
      const noticeMsg = await ctx.reply('📥 正在接收圖片並轉發至 Antigravity...');
      return dispatchImagePrompt(ctx, localFilePath, caption, noticeMsg);
    }

    // 情況 2：照片本身無內嵌文字，啟動 1.8 秒緩衝（支援先傳圖、隨後秒打字的使用情境）
    const noticeMsg = await ctx.reply('📥 正在接收圖片（若有文字說明可直接發送）...');
    const timeoutId = setTimeout(async () => {
      pendingImageBuffer.delete(userId);
      try {
        await dispatchImagePrompt(ctx, localFilePath, '', noticeMsg);
      } catch (err) {
        console.error('[圖片超時派發錯誤]:', err);
      }
    }, 1800);

    pendingImageBuffer.set(userId, {
      ctx,
      localFilePath,
      noticeMsg,
      timeoutId
    });

  } catch (err) {
    console.error('[處理圖片訊息錯誤]:', err);
    await ctx.reply(`❌ 圖片處理失敗: ${err.message}`);
  }
}


// 監聽 Telegram 圖片訊息（非同步派發）
bot.on('photo', (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.reply('未授權的使用者。');
  }

  handleUserPhotoRequest(ctx).catch(err => {
    console.error('非同步處理圖片時發生未捕獲錯誤:', err);
  });
});

bot.on('text', (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.reply('未授權的使用者。');
  }

  handleUserRequest(ctx).catch(err => {
    console.error('非同步處理訊息時發生未捕獲錯誤:', err);
  });
});


// 監聽 Takeover 官方卡片授權選項點擊事件
bot.action(/^tkover:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  const rawVal = ctx.match[1];
  await ctx.answerCbQuery('⚡ 正在執行授權選擇...');

  // 取得目標 Client（優先使用 activeTakeoverSession，其次使用即時探測）
  let client = activeTakeoverSession?.client;
  let targetSession = null;
  let needDetach = false;

  if (!client) {
    const target = await findAntigravityInputTarget();
    if (target) {
      targetSession = await target.createCDPSession();
      client = targetSession;
      needDetach = true;
    }
  }

  if (!client) {
    return ctx.answerCbQuery('⚠️ 找不到 Antigravity 視窗，請確認側邊欄已展開。', { show_alert: true });
  }

  try {
    const execRes = await executeTakeoverAction(client, rawVal);
    if (execRes.success) {
      const chosenText = execRes.text || rawVal;
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        null,
        `✅ *已授權 / 選擇*：\`${escapeMarkdown(chosenText)}\`\n\n⏳ Antigravity 獲得授權，正在繼續執行任務中...`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      activeTakeoverSession = null;
      globalTakeoverSignature = '';
    } else {
      await ctx.reply(`❌ 執行選擇失敗: ${execRes.reason}`);
    }
  } catch (err) {
    console.error('[Takeover 點擊錯誤]:', err);
    await ctx.reply(`❌ 執行出錯: ${err.message}`);
  } finally {
    if (needDetach && targetSession) {
      await targetSession.detach().catch(() => {});
    }
  }
});

// 監聽 Inline Button 互動授權與選項點擊事件
bot.action(/^act:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  const actionId = ctx.match[1];
  if (!activeInteractionSession || !activeInteractionSession.client) {
    return ctx.answerCbQuery('⚠️ 該請求已失效、已超時或已在本機完成。', { show_alert: true });
  }

  try {
    const clickRes = await activeInteractionSession.client.send('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.querySelector('[data-bridge-action-id="${actionId}"]');
        if (btn) {
          btn.click();
          return { success: true, text: btn.innerText.trim() || btn.getAttribute('aria-label') || '' };
        }
        return { success: false, reason: '按鈕未找到或已更新' };
      })()`,
      returnByValue: true
    });

    const val = clickRes?.result?.value;
    if (val && val.success) {
      const clickedName = val.text || '已選擇';
      await ctx.answerCbQuery(`✅ 已執行：${clickedName}`);

      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          null,
          `✅ *已授權 / 選擇*：\`${escapeMarkdown(clickedName)}\`\n\n⏳ Antigravity 正在繼續執行任務中...`,
          { parse_mode: 'Markdown' }
        );
      } catch { }

      activeInteractionSession = null;
    } else {
      await ctx.answerCbQuery(`❌ 操作失敗: ${val?.reason || '按鈕不存在'}`, { show_alert: true });
    }
  } catch (err) {
    console.error('[點擊互動按鈕錯誤]:', err);
    await ctx.answerCbQuery(`❌ 執行出錯: ${err.message}`, { show_alert: true });
  }
});


// 監聽 Inline Button 切換模型事件
bot.action(/^switch_model:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  const targetIdx = ctx.match[1];
  await ctx.answerCbQuery('🔄 正在切換模型...');
  const chatId = ctx.chat?.id || ctx.from?.id;
  return executeModelSwitch(chatId, targetIdx);
});

// 監聽 Inline Button 查看用量事件
bot.action('view_usage', async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  await ctx.answerCbQuery('📊 正在查詢用量配額...');
  const chatId = ctx.chat?.id || ctx.from?.id;
  return executeUsageQuery(chatId);
});

// 監聽 Inline Button 手動執行排程
bot.action(/^task_run:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  const taskId = ctx.match[1];
  const task = scheduler.tasks.find(t => t.id === taskId);
  if (!task) {
    return ctx.answerCbQuery('❌ 找不到該任務', { show_alert: true });
  }

  await ctx.answerCbQuery(`🚀 開始執行【${task.name}】...`);
  scheduler.runTask(taskId, true).catch(err => {
    bot.telegram.sendMessage(allowedId, `❌ 任務【${task.name}】執行出錯: ${err.message}`).catch(() => { });
  });
});

// 監聽 Inline Button 切換啟用/停用狀態
bot.action(/^task_toggle:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  const taskId = ctx.match[1];
  const updated = scheduler.toggleTask(taskId);
  if (!updated) {
    return ctx.answerCbQuery('❌ 找不到該任務', { show_alert: true });
  }

  await ctx.answerCbQuery(`${updated.enabled ? '🟢 已啟用' : '⏸️ 已停用'}【${updated.name}】`);
  const { text, buttons } = renderTasksMessage();
  return ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  }).catch(() => { });
});

// 監聽 Inline Button 刪除排程
bot.action(/^task_del:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  const taskId = ctx.match[1];
  const removed = scheduler.deleteTask(taskId);
  if (!removed) {
    return ctx.answerCbQuery('❌ 找不到該任務', { show_alert: true });
  }

  await ctx.answerCbQuery(`🗑️ 已刪除【${removed.name}】`);
  const { text, buttons } = renderTasksMessage();
  return ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  }).catch(() => { });
});

// 監聽 Inline Button 重新整理排程清單
bot.action('task_refresh', async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  await ctx.answerCbQuery('🔄 已重新整理清單');
  const { text, buttons } = renderTasksMessage();
  return ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  }).catch(() => { });
});

// 監聽 Inline Button 查看新增排程教學
bot.action('task_add_help', async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  await ctx.answerCbQuery('📖 自然語言排程說明');
  return ctx.reply(
    `📖 *自然語言排程指令教學*\n\n` +
    `只需輸入 \`/schedule\` 並加上白話需求，例如：\n\n` +
    `• \`/schedule 每個工作日18:00執行籌碼爬蟲並總結亮點\`\n` +
    `• \`/schedule 每天早上8點半整理美股開盤要聞\`\n` +
    `• \`/schedule 每隔2小時檢查系統運作狀態\`\n` +
    `• \`/schedule 每週日晚上9點產出週報\`\n\n` +
    `💡 系統將自動解析時間並彈出【確認按鈕】，點擊即可一鍵加入排程！`,
    { parse_mode: 'Markdown' }
  );
});

// 監聽 Inline Button 確認加入排程
bot.action(/^task_confirm:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  const confirmId = ctx.match[1];
  const taskData = pendingSchedules.get(confirmId);
  if (!taskData) {
    return ctx.answerCbQuery('⚠️ 該確認請求已逾期或失效，請重新發送。', { show_alert: true });
  }

  pendingSchedules.delete(confirmId);

  try {
    const newTask = scheduler.addTask({
      name: taskData.name,
      cron: taskData.cron,
      prompt: taskData.prompt,
      newSession: true,
      enabled: true
    });

    await ctx.answerCbQuery('🎉 排程已成功建立！');
    const nextRunStr = calculateNextRun(newTask.cron);

    return ctx.editMessageText(
      `🎉 *排程任務建立成功！*\n\n` +
      `📌 *任務名稱*：${newTask.name}\n` +
      `🆔 *任務 ID*：\`${newTask.id}\`\n` +
      `⏰ *Cron 表達式*：\`${newTask.cron}\`\n` +
      `🕒 *下次預計執行*：\`${nextRunStr || '計算中'}\`\n` +
      `📝 *Prompt*：\`${newTask.prompt}\`\n\n` +
      `💡 輸入 \`/tasks\` 可隨時查看排程狀態或以按鈕立即測跑。`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    return ctx.editMessageText(`❌ 建立排程失敗: ${err.message}`);
  }
});

// 監聽 Inline Button 取消加入排程
bot.action(/^task_cancel:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  const confirmId = ctx.match[1];
  pendingSchedules.delete(confirmId);
  await ctx.answerCbQuery('已取消建立排程。');
  return ctx.editMessageText('❌ 已取消建立此排程。');
});

// 監聽 Inline Button 改由 LLM 重新解析排程
bot.action(/^task_llm:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  const confirmId = ctx.match[1];
  const taskData = pendingSchedules.get(confirmId);
  if (!taskData || !taskData.rawInput) {
    return ctx.answerCbQuery('⚠️ 該確認請求已逾期或失效，請重新發送。', { show_alert: true });
  }

  await ctx.answerCbQuery('🧠 正在請求 LLM 重新深度解析...');
  await ctx.editMessageText('🧠 正在請求 Antigravity LLM 深度理解排程語意中...').catch(() => { });

  try {
    const llmParsed = await parseScheduleWithLLM(taskData.rawInput);
    pendingSchedules.set(confirmId, {
      ...llmParsed,
      rawInput: taskData.rawInput
    });

    const { text: cardText, buttons } = renderScheduleConfirmCard(llmParsed, false, confirmId);
    return ctx.editMessageText(cardText, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    return ctx.editMessageText(
      `❌ LLM 重新解析失敗：${err.message}\n\n您可嘗試更具體描述需求後重新輸入指令。`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ 取消', callback_data: `task_cancel:${confirmId}` }]
          ]
        }
      }
    );
  }
});

// 監聽 Inline Button 一鍵執行 Skill
bot.action(/^skill_run:(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  const skillIdx = parseInt(ctx.match[1], 10);
  const skills = getWorkspaceSkills();
  const skill = skills[skillIdx];
  if (!skill) {
    return ctx.answerCbQuery('❌ 找不到該技能，請重新整理清單', { show_alert: true });
  }

  await ctx.answerCbQuery(`⚡ 正在啟動【${skill.name}】...`);
  const chatId = ctx.chat?.id || ctx.from?.id;
  return executeSkill(chatId, skill);
});

// 監聽 Inline Button 重新整理 Skills 清單
bot.action('skills_refresh', async (ctx) => {
  const userId = ctx.from.id;
  if (String(userId) !== String(allowedId)) {
    return ctx.answerCbQuery('未授權的操作。', { show_alert: true });
  }

  await ctx.answerCbQuery('🔄 已重新整理 Skills 清單');
  const skills = getWorkspaceSkills();
  const { text, buttons } = renderSkillsMessage(skills, targetProject);
  return ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  }).catch(err => {
    console.warn('[Skills] 編輯 Markdown 訊息失敗，降級為純文字:', err.message);
    return ctx.editMessageText(text.replace(/[*_`\\]/g, ''), {
      reply_markup: { inline_keyboard: buttons }
    }).catch(() => { });
  });
});

// 初始化動態排程管理器
scheduler.init({
  executeCallback: executeScheduledTask,
  logger: console.log
});

console.log('正在啟動 Telegram Bot Polling...');
bot.launch().then(() => {
  bot.telegram.setMyCommands([
    { command: 'skills', description: '查看工作區自定義技能與一鍵執行' },
    { command: 'schedule', description: '自然語言建立排程 (例: 每個工作日18:00分析台股)' },
    { command: 'tasks', description: '查看與管理排程清單 (支援按鈕測跑/停用/刪除)' },
    { command: 'models', description: '查看目前模型與可用清單' },
    { command: 'usage', description: '查看帳號額度與配額使用量' },
    { command: 'new', description: '開啟新的對話 Session' },
    { command: 'stop', description: '暫停 / 中斷當前執行' },
    { command: 'status', description: '檢查 Antigravity 連線與忙碌狀態' },
    { command: 'help', description: '查看指令說明' }
  ]).catch(() => { });
}).catch(err => {
  console.error('Telegram Bot 啟動異常:', err);
});

console.log(`=== Bridge 服務已註冊啟動！綁定專案: [${targetProject}] ===`);

// 背景輪詢推播
(async () => {
  console.log('開始背景輪詢偵測 Antigravity 面板...');
  const readyTarget = await waitForAntigravityTarget(20, 1500);
  if (readyTarget) {
    await bot.telegram.sendMessage(
      allowedId,
      `🟢 *VS Code Antigravity 已連線就緒！*\n\n📁 綁定專案：\`${targetProject}\`\n💬 狀態：已偵測到輸入框，可直接傳送指令。`,
      { parse_mode: 'Markdown' }
    );
  } else {
    console.warn('初次啟動輪詢逾時，請確認側邊欄是否已點開。');
  }
})().catch(err => console.error('開機偵測異常:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --- 背景全時守護：定時監聽 Antigravity 權限請求（無論指令何處發起）---
setInterval(async () => {
  // 若當前正有 Telegram 任務執行中的 Takeover 會話，由任務輪詢負責
  if (activeTakeoverSession && activeTakeoverSession.client) return;

  try {
    const target = await findAntigravityInputTarget();
    if (!target) return;

    let client = null;
    try {
      client = await target.createCDPSession();
      const detectRes = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const takeoverCard = document.querySelector('[data-testid="interaction-takeover-card"]');
          if (!takeoverCard || takeoverCard.offsetParent === null) return null;

          const headerEl = takeoverCard.querySelector('[data-testid="ask-question-header-text"]');
          const headerText = headerEl ? headerEl.innerText.trim() : 'Antigravity 請求確認';

          const targetEl = takeoverCard.querySelector('[data-testid="permission-target-editor"], pre');
          const targetText = targetEl ? (targetEl.value || targetEl.innerText || '').trim() : '';

          const options = [];
          const optLabels = Array.from(takeoverCard.querySelectorAll('[data-testid="ask-question-option"]'));
          optLabels.forEach((label, idx) => {
            const radio = label.querySelector('input[type="radio"]');
            const textEl = label.querySelector('[data-testid="ask-question-option-text"]');
            const optText = textEl ? textEl.innerText.trim() : ('選項 ' + (idx + 1));
            const val = radio ? radio.value : String(idx + 1);
            options.push({
              rawVal: val,
              label: (idx + 1) + '. ' + optText
            });
          });

          const noLabel = takeoverCard.querySelector('label[for*="__write_in__"]');
          if (noLabel) {
            const radio = noLabel.querySelector('input[type="radio"]');
            const noVal = radio ? radio.value : '__write_in__';
            options.push({
              rawVal: noVal,
              label: '5. 拒絕 (No)'
            });
          }

          const skipBtn = takeoverCard.querySelector('[data-testid="interaction-skip-button"]');
          if (skipBtn) {
            options.push({
              rawVal: 'skip',
              label: '略過 (Skip)'
            });
          }

          return {
            header: headerText,
            target: targetText,
            options
          };
        })()`,
        returnByValue: true
      });

      const takeover = detectRes?.result?.value;
      if (takeover && takeover.options && takeover.options.length > 0) {
        const sig = takeover.header + '::' + takeover.target + '::' + takeover.options.map(o => o.rawVal).join(',');
        if (sig !== globalTakeoverSignature) {
          globalTakeoverSignature = sig;
          console.log(`[背景全時守護] 偵測到 Antigravity 權限請求：${takeover.header}`);

          const inlineKeyboard = takeover.options.map(o => ([{
            text: o.label.length > 40 ? o.label.slice(0, 37) + '...' : o.label,
            callback_data: `tkover:${o.rawVal}`
          }]));

          const cardMsg =
            `⚠️ *Antigravity 正在等待授權（背景偵測）*：\n\n` +
            `❓ *標題*：${escapeMarkdown(takeover.header)}\n` +
            (takeover.target ? `📁 *目標路徑*：\`${escapeMarkdown(takeover.target)}\`\n\n` : '\n') +
            `👇 *請在下方選擇授權操作*：`;

          await bot.telegram.sendMessage(allowedId, cardMsg, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard }
          }).catch(err => console.warn('[背景守護推播失敗]:', err.message));
        }
      } else {
        if (globalTakeoverSignature) {
          globalTakeoverSignature = '';
        }
      }
    } finally {
      if (client) {
        await client.detach().catch(() => {});
      }
    }
  } catch (err) {
    // 忽略輪詢異常
  }
}, 1500);
