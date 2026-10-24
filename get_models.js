require('dotenv').config();
const puppeteer = require('puppeteer-core');

const cdpPort = process.env.CDP_PORT || 9222;

/**
 * 取得 Puppeteer Browser 連線
 */
async function getBrowser() {
  return await puppeteer.connect({
    browserURL: `http://127.0.0.1:${cdpPort}`,
    defaultViewport: null
  });
}

/**
 * 尋找 Antigravity 對話視窗的 Execution Context (相容 Target 與 Frame)
 */
async function findAntigravityChatContext(browser) {
  // 策略 1：從 browser.pages() 的 frames 尋找
  const pages = await browser.pages();
  for (const page of pages) {
    for (const frame of page.frames()) {
      const url = frame.url();
      if (url.includes('/c/') && (url.includes('extensionView=true') || url.includes('127.0.0.1'))) {
        try {
          const hasTrigger = await frame.evaluate(() => {
            return !!document.querySelector('[data-testid="model-selector-trigger"], button[aria-label*="Select model"]');
          });
          if (hasTrigger) {
            return { type: 'frame', handle: frame, url };
          }
        } catch {
          // ignore
        }
      }
    }
  }

  // 策略 2：從 browser.targets() 逐一探測
  const targets = browser.targets();
  const candidateTargets = targets.filter(t => {
    const u = t.url();
    return u.includes('127.0.0.1') || u.includes('vscode-webview') || u.includes('extensionView');
  });

  for (const target of candidateTargets) {
    try {
      const client = await target.createCDPSession();
      const evalRes = await client.send('Runtime.evaluate', {
        expression: `(() => {
          return !!document.querySelector('[data-testid="model-selector-trigger"], button[aria-label*="Select model"]');
        })()`,
        returnByValue: true
      });
      await client.detach().catch(() => {});

      if (evalRes?.result?.value === true) {
        return { type: 'target', handle: target, url: target.url() };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * 在給定的 Context 中執行 Evaluate
 */
async function runEvaluate(context, fnString, ...args) {
  if (context.type === 'frame') {
    return await context.handle.evaluate(new Function(`return (${fnString})(...arguments)`), ...args);
  } else {
    const client = await context.handle.createCDPSession();
    try {
      const res = await client.send('Runtime.evaluate', {
        expression: `(${fnString})(${args.map(a => JSON.stringify(a)).join(',')})`,
        awaitPromise: true,
        returnByValue: true
      });
      return res?.result?.value;
    } finally {
      await client.detach().catch(() => {});
    }
  }
}

/**
 * 尋找並解析 Settings (Models & Usage) 頁面中的配額資訊
 */
async function extractUsageFromSettings(browser, context = null, maxRetries = 15, retryDelayMs = 300) {
  // 檢查目前是否已有 settings frame
  let settingsFrame = null;
  const initialPages = await browser.pages();
  for (const page of initialPages) {
    for (const frame of page.frames()) {
      if (frame.url().includes('settings-standalone') || frame.url().includes('settings')) {
        settingsFrame = frame;
        break;
      }
    }
    if (settingsFrame) break;
  }

  // 若尚未開啟 Settings 面板，透過 context 觸發點擊 settings-button 開啟
  if (!settingsFrame && context) {
    try {
      await runEvaluate(context, `async () => {
        const settingsBtn = document.querySelector('[data-testid="settings-button"]') ||
          Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim() === 'Settings');
        if (settingsBtn) {
          settingsBtn.click();
        }
      }`);
    } catch {
      // ignore
    }
  }

  // 若 settingsFrame 已存在，主動執行 location.reload() 強制清除頁面快取並重新向伺服器拉取最新用量數據
  if (settingsFrame) {
    try {
      await settingsFrame.evaluate(() => location.reload());
      await new Promise(r => setTimeout(r, 400));
    } catch {
      // ignore
    }
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const pages = await browser.pages();
    for (const page of pages) {
      for (const frame of page.frames()) {
        const url = frame.url();
        if (url.includes('settings-standalone') || url.includes('settings')) {
          try {
            const usageData = await frame.evaluate(async () => {
              if (!document.body) return null;

              // 若不在 Models 頁籤，點擊 Models 導航項目
              if (!document.body.innerText.includes('Models & Usage')) {
                const modelsBtn = document.querySelector('[data-testid="settings-nav-item-Models"]') ||
                  Array.from(document.querySelectorAll('button')).find(el => (el.innerText || '').trim() === 'Models');
                if (modelsBtn) {
                  modelsBtn.click();
                  await new Promise(r => setTimeout(r, 250));
                }
              }

              const body = document.body ? document.body.innerText : '';
              if (!body.includes('Models & Usage') || !body.includes('Limit Remaining')) {
                return null;
              }

              const planMatch = body.match(/Your Plan:\s*([^\n]+)/i);
              const plan = planMatch ? planMatch[1].trim() : null;

              const geminiBlock = body.match(/Gemini Models[\s\S]*?(?=Claude and GPT|$)/i)?.[0] || '';
              const claudeBlock = body.match(/Claude and GPT models[\s\S]*?(?=Gemini 4 Argon|$)/i)?.[0] || '';
              const argonBlock = body.match(/Gemini 4 Argon[\s\S]*/i)?.[0] || '';

              function extractLimits(block) {
                const parts = block.split(/Five Hour Limit Remaining/i);
                const weeklyPart = parts[0] || '';
                const fiveHourPart = parts[1] || '';

                const weeklyMatch = weeklyPart.match(/(\d+%\s*|\d+\s*%)/);
                const weeklyRefreshMatch = weeklyPart.match(/it will fully refresh in ([^\n\.]+)/i);

                const fiveHourMatch = fiveHourPart.match(/(\d+%\s*|\d+\s*%)/);
                const fiveHourRefreshMatch = fiveHourPart.match(/it will fully refresh in ([^\n\.]+)/i);

                return {
                  weeklyRemaining: weeklyMatch ? weeklyMatch[1].trim() : null,
                  weeklyRefresh: weeklyRefreshMatch ? weeklyRefreshMatch[1].trim() : null,
                  fiveHourRemaining: fiveHourMatch ? fiveHourMatch[1].trim() : null,
                  fiveHourRefresh: fiveHourRefreshMatch ? fiveHourRefreshMatch[1].trim() : null
                };
              }

              function extractArgonLimit(block) {
                if (!block) return null;
                const weeklyMatch = block.match(/(\d+%\s*|\d+\s*%)/);
                const weeklyRefreshMatch = block.match(/it will fully refresh in ([^\n\.]+)/i);
                return {
                  weeklyRemaining: weeklyMatch ? weeklyMatch[1].trim() : null,
                  weeklyRefresh: weeklyRefreshMatch ? weeklyRefreshMatch[1].trim() : null
                };
              }

              return {
                plan,
                gemini: extractLimits(geminiBlock),
                claudeGpt: extractLimits(claudeBlock),
                argon: extractArgonLimit(argonBlock)
              };
            });

            if (usageData && usageData.plan) {
              return usageData;
            }
          } catch {
            // ignore
          }
        }
      }
    }
    await new Promise(r => setTimeout(r, retryDelayMs));
  }

  return null;
}

/**
 * 核心函式：偵測 Antigravity 可用的 Model 清單，並可進一步點擊 View Usage 取得配額
 * @param {Object} options
 * @param {boolean} options.includeUsage - 是否抓取用量配額 (預設 true)
 */
async function getAntigravityModels(options = { includeUsage: true }) {
  const { includeUsage = true } = options;
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    throw new Error(`無法連線至 CDP (127.0.0.1:${cdpPort})，請確認 VS Code 是否已啟動且開放除錯連接埠。\n錯誤: ${err.message}`);
  }

  try {
    const context = await findAntigravityChatContext(browser);
    if (!context) {
      throw new Error('未找到 Antigravity 對話面板，請確認 VS Code 側邊欄已展開！');
    }

    const stageOneResult = await runEvaluate(context, `async () => {
      const trigger = document.querySelector('[data-testid="model-selector-trigger"], button[aria-label*="Select model"]');
      if (!trigger) {
        return { success: false, reason: '找不到 model-selector-trigger 按鈕' };
      }

      const currentModelRaw = (trigger.innerText || trigger.textContent || '').trim();
      const currentModelAria = trigger.getAttribute('aria-label') || '';

      let panel = document.querySelector('[data-testid="model-selector-panel"]');
      if (!panel) {
        trigger.click();
        for (let wait = 0; wait < 10; wait++) {
          await new Promise(r => setTimeout(r, 100));
          panel = document.querySelector('[data-testid="model-selector-panel"]');
          if (panel) break;
        }
      }

      const models = [];
      if (panel) {
        const items = Array.from(panel.querySelectorAll('[role="menuitem"], [data-testid="model-selector-item"], [data-testid="model-selector-effort-group"]'));

        for (const item of items) {
          const text = (item.innerText || item.textContent || '').trim();
          if (!text || text === 'Model' || text === 'View Usage') continue;

          const lines = text.split('\\n').map(l => l.trim()).filter(Boolean);
          const modelName = lines[0];

          let effort = null;
          const badges = [];

          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (['Low', 'Medium', 'High', 'Auto'].includes(line)) {
              effort = line;
            } else {
              badges.push(line);
            }
          }

          if (modelName && !models.some(m => m.name === modelName)) {
            models.push({
              name: modelName,
              effort: effort,
              badges: badges,
              isSelected: currentModelRaw.includes(modelName)
            });
          }
        }
      }

      // 關閉下拉選單恢復原狀
      if (document.querySelector('[data-testid="model-selector-panel"]')) {
        trigger.click();
      }

      return {
        success: true,
        currentModel: {
          raw: currentModelRaw,
          ariaLabel: currentModelAria
        },
        models
      };
    }`);

    if (!stageOneResult || !stageOneResult.success) {
      return stageOneResult;
    }

    let usage = null;
    if (includeUsage) {
      usage = await extractUsageFromSettings(browser, context);
    }

    return {
      success: true,
      currentModel: stageOneResult.currentModel,
      models: stageOneResult.models,
      usage
    };

  } finally {
    await browser.disconnect().catch(() => {});
  }
}

/**
 * 延伸功能：切換 Antigravity 使用的 Model
 * @param {string|number} targetQuery - 模型名稱關鍵字 (如 '3.8', 'sonnet') 或清單序號 (如 1, 2, 6)
 */
async function switchAntigravityModel(targetQuery) {
  if (!targetQuery) {
    throw new Error('請提供欲切換的模型名稱關鍵字或序號！');
  }

  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    throw new Error(`無法連線至 CDP (127.0.0.1:${cdpPort})，請確認 VS Code 是否已啟動且開放除錯連接埠。\n錯誤: ${err.message}`);
  }

  try {
    const context = await findAntigravityChatContext(browser);
    if (!context) {
      throw new Error('未找到 Antigravity 對話面板，請確認 VS Code 側邊欄已展開！');
    }

    const switchResult = await runEvaluate(context, `async (targetQuery) => {
      const trigger = document.querySelector('[data-testid="model-selector-trigger"], button[aria-label*="Select model"]');
      if (!trigger) {
        return { success: false, reason: '找不到 model-selector-trigger 按鈕' };
      }

      const currentBefore = (trigger.innerText || trigger.textContent || '').trim();

      // 展開面板
      let panel = document.querySelector('[data-testid="model-selector-panel"]');
      if (!panel) {
        trigger.click();
        for (let wait = 0; wait < 10; wait++) {
          await new Promise(r => setTimeout(r, 100));
          panel = document.querySelector('[data-testid="model-selector-panel"]');
          if (panel) break;
        }
      }

      if (!panel) {
        return { success: false, reason: '無法開啟 model-selector-panel 下拉選單' };
      }

      // 收集可選模型清單項目
      const items = Array.from(panel.querySelectorAll('[role="menuitem"]'));
      const modelItems = items.filter(it => {
        const txt = (it.innerText || '').trim();
        return txt && txt !== 'Model' && txt !== 'View Usage';
      });

      let matchItem = null;
      if (typeof targetQuery === 'number' || /^\\d+$/.test(targetQuery)) {
        const idx = parseInt(targetQuery, 10) - 1;
        matchItem = modelItems[idx];
      } else {
        const q = String(targetQuery).toLowerCase();
        matchItem = modelItems.find(it => (it.innerText || '').toLowerCase().includes(q));
      }

      if (!matchItem) {
        trigger.click(); // 關閉面板
        return {
          success: false,
          reason: \`找不到符合 "\${targetQuery}" 的模型選項\`,
          available: modelItems.map((it, idx) => \`\${idx + 1}. \${(it.innerText || '').split('\\n')[0].trim()}\`)
        };
      }

      const targetName = (matchItem.innerText || '').split('\\n')[0].trim();

      // 若目前已經是該模型
      if (currentBefore.includes(targetName)) {
        trigger.click(); // 關閉面板
        return {
          success: true,
          switched: false,
          message: '目前已在使用此模型，無須變更',
          currentModel: currentBefore
        };
      }

      // 點擊選取目標模型
      matchItem.click();
      await new Promise(r => setTimeout(r, 600));

      const currentAfter = (trigger.innerText || trigger.textContent || '').trim();

      return {
        success: true,
        switched: true,
        previousModel: currentBefore,
        currentModel: currentAfter,
        targetName
      };
    }`, targetQuery);

    return switchResult;

  } finally {
    await browser.disconnect().catch(() => {});
  }
}

// 命令列執行支援
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const targetArg = args[0];

    // 若傳入參數，代表執行切換模型
    if (targetArg) {
      console.log(`🔄 正在切換 Antigravity 模型為: "${targetArg}"...\n`);
      try {
        const res = await switchAntigravityModel(targetArg);
        if (!res.success) {
          console.error(`❌ 切換失敗: ${res.reason}`);
          if (res.available) {
            console.log('\n可選模型列表:');
            res.available.forEach(m => console.log(`   ${m}`));
          }
          process.exit(1);
        }

        if (!res.switched) {
          console.log(`ℹ️ ${res.message}`);
          console.log(`📌 當前模型: ${res.currentModel}`);
        } else {
          console.log('🎉 模型切換成功！');
          console.log(`   變更前: ${res.previousModel}`);
          console.log(`   變更後: ${res.currentModel}`);
        }
      } catch (err) {
        console.error('❌ 執行出錯:', err.message);
        process.exit(1);
      }
      return;
    }

    // 若無參數，預設列出清單與用量
    console.log('🔍 正在連線探測 Antigravity Extension 的 Model 清單與 Usage 配額...\n');
    try {
      const data = await getAntigravityModels({ includeUsage: true });
      if (!data || !data.success) {
        console.error('❌ 探測失敗:', data?.reason || '未知錯誤');
        process.exit(1);
      }

      console.log('======================================================');
      console.log(`📌 目前選取模型: ${data.currentModel.raw}`);
      console.log('======================================================');
      console.log(`📋 可選模型清單 (共 ${data.models.length} 個)：\n`);

      data.models.forEach((m, idx) => {
        const mark = m.isSelected ? '👉 [*目前使用*]' : '   ';
        const effortStr = m.effort ? ` (Effort: ${m.effort})` : '';
        const badgeStr = m.badges && m.badges.length > 0 ? ` [${m.badges.join(', ')}]` : '';
        console.log(`${mark} ${idx + 1}. ${m.name}${effortStr}${badgeStr}`);
      });

      if (data.usage) {
        console.log('\n======================================================');
        console.log(`📊 模型配額與使用量 (Models & Usage)`);
        console.log('======================================================');
        console.log(`🎖️ 帳號方案: ${data.usage.plan || '未知'}\n`);

        console.log('🔹 Gemini Models:');
        console.log(`   • 每週剩餘: ${data.usage.gemini?.weeklyRemaining || 'N/A'}${data.usage.gemini?.weeklyRefresh ? ` (將在 ${data.usage.gemini.weeklyRefresh} 完全重置)` : ''}`);
        console.log(`   • 5小時剩餘: ${data.usage.gemini?.fiveHourRemaining || 'N/A'}${data.usage.gemini?.fiveHourRefresh ? ` (將在 ${data.usage.gemini.fiveHourRefresh} 完全重置)` : ''}`);

        console.log('\n🔹 Claude & GPT Models:');
        console.log(`   • 每週剩餘: ${data.usage.claudeGpt?.weeklyRemaining || 'N/A'}${data.usage.claudeGpt?.weeklyRefresh ? ` (將在 ${data.usage.claudeGpt.weeklyRefresh} 完全重置)` : ''}`);
        console.log(`   • 5小時剩餘: ${data.usage.claudeGpt?.fiveHourRemaining || 'N/A'}${data.usage.claudeGpt?.fiveHourRefresh ? ` (將在 ${data.usage.claudeGpt.fiveHourRefresh} 完全重置)` : ''}`);

        if (data.usage.argon?.weeklyRemaining) {
          console.log('\n🔹 Gemini 4 Argon:');
          console.log(`   • 每週剩餘: ${data.usage.argon.weeklyRemaining}${data.usage.argon.weeklyRefresh ? ` (將在 ${data.usage.argon.weeklyRefresh} 完全重置)` : ''}`);
        }
      }

      console.log('======================================================');
      console.log('💡 提示：可使用 `node get_models.js <序號或關鍵字>` 快速切換模型');
      console.log('   範例：node get_models.js 1 或 node get_models.js sonnet');

    } catch (err) {
      console.error('❌ 執行失敗:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  getAntigravityModels,
  switchAntigravityModel
};
