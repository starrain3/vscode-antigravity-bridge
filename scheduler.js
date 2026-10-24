const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const DEFAULT_TIMEZONE = process.env.TZ || 'Asia/Taipei';

class SchedulerManager {
  constructor() {
    this.tasks = [];
    this.jobs = new Map(); // taskId -> ScheduledTask
    this.executeCallback = null;
    this.logger = console.log;
    this.isInternalSaving = false;
    this.fileWatcher = null;
  }

  /**
   * 初始化排程管理器
   * @param {Object} options
   * @param {Function} options.executeCallback - 執行任務時的非同步處理常式 (task, isManual) => Promise<void>
   * @param {Function} [options.logger] - 記錄函式
   */
  init({ executeCallback, logger }) {
    this.executeCallback = executeCallback;
    if (logger) this.logger = logger;

    this.loadFromFile();
    this.startAllJobs();
    this.watchConfigFile();

    this.logger(`[Scheduler] 動態排程模組初始化完成，當前共載入 ${this.tasks.length} 個排程任務。`);
  }

  /**
   * 從 schedules.json 讀取排程設定
   */
  loadFromFile() {
    try {
      if (!fs.existsSync(SCHEDULES_FILE)) {
        const initialTasks = [
          {
            id: 'sample_daily_chips',
            name: '每日籌碼分析範例',
            cron: '0 18 * * 1-5',
            prompt: '請檢查今日台股籌碼狀態並總結重點個股。',
            newSession: true,
            enabled: false,
            createdAt: new Date().toISOString(),
            lastRunAt: null,
            lastStatus: null
          }
        ];
        this.tasks = initialTasks;
        this.saveToFile();
        return;
      }

      const raw = fs.readFileSync(SCHEDULES_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.tasks = parsed;
      } else {
        this.logger('[Scheduler] 警告: schedules.json 格式非陣列，保留記憶體現有任務。');
      }
    } catch (err) {
      this.logger('[Scheduler] 讀取 schedules.json 失敗:', err.message);
    }
  }

  /**
   * 將當前任務儲存至 schedules.json
   */
  saveToFile() {
    this.isInternalSaving = true;
    try {
      fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(this.tasks, null, 2), 'utf-8');
    } catch (err) {
      this.logger('[Scheduler] 儲存 schedules.json 失敗:', err.message);
    } finally {
      setTimeout(() => {
        this.isInternalSaving = false;
      }, 500);
    }
  }

  /**
   * 監聽 schedules.json 檔案變更，支援本機編輯熱重載 (Hot-reload)
   */
  watchConfigFile() {
    if (this.fileWatcher) return;

    let debounceTimer = null;
    try {
      this.fileWatcher = fs.watch(SCHEDULES_FILE, (eventType) => {
        if (this.isInternalSaving) return;
        if (eventType === 'change') {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            this.logger('[Scheduler] 偵測到 schedules.json 外部變更，執行熱重載 (Hot-reload)...');
            this.reload();
          }, 400);
        }
      });
    } catch (err) {
      this.logger('[Scheduler] 監聽 schedules.json 失敗:', err.message);
    }
  }

  /**
   * 停止單一任務的定時 Job
   */
  stopJob(taskId) {
    if (this.jobs.has(taskId)) {
      const job = this.jobs.get(taskId);
      try {
        job.stop();
        if (typeof job.destroy === 'function') job.destroy();
      } catch { }
      this.jobs.delete(taskId);
    }
  }

  /**
   * 為指定任務註冊定時 Job
   */
  registerJob(task) {
    this.stopJob(task.id);

    if (!task.enabled) {
      return false;
    }

    if (!cron.validate(task.cron)) {
      this.logger(`[Scheduler] 任務 [${task.name}] 的 Cron 表達式無效: ${task.cron}`);
      return false;
    }

    try {
      const job = cron.schedule(
        task.cron,
        async () => {
          this.logger(`[Scheduler] ⏰ 排程時間到達，觸發任務: 【${task.name}】`);
          await this.runTask(task.id, false);
        },
        {
          timezone: DEFAULT_TIMEZONE
        }
      );

      this.jobs.set(task.id, job);
      return true;
    } catch (err) {
      this.logger(`[Scheduler] 註冊任務 [${task.name}] 失敗:`, err.message);
      return false;
    }
  }

  /**
   * 啟動所有已啟用的排程
   */
  startAllJobs() {
    // 先停止現有全部 Job
    for (const [id] of this.jobs) {
      this.stopJob(id);
    }

    let activeCount = 0;
    for (const task of this.tasks) {
      if (task.enabled) {
        const ok = this.registerJob(task);
        if (ok) activeCount++;
      }
    }
    this.logger(`[Scheduler] 已註冊並啟動 ${activeCount} 個排程定時器。`);
  }

  /**
   * 執行任務（手動或定時）
   * @param {string} taskId
   * @param {boolean} isManual
   */
  async runTask(taskId, isManual = false) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) {
      throw new Error(`找不到任務 ID: ${taskId}`);
    }

    if (!this.executeCallback) {
      throw new Error('未設定執行回呼常式');
    }

    task.lastRunAt = new Date().toISOString();
    try {
      await this.executeCallback(task, isManual);
      task.lastStatus = 'success';
    } catch (err) {
      task.lastStatus = `error: ${err.message}`;
      this.logger(`[Scheduler] 任務 【${task.name}】 執行失敗:`, err);
      throw err;
    } finally {
      this.saveToFile();
    }
  }

  /**
   * 動態新增排程任務
   */
  addTask({ name, cron: cronExpr, prompt, newSession = true, enabled = true }) {
    if (!cronExpr || !cron.validate(cronExpr.trim())) {
      throw new Error(`Cron 表達式格式無效: "${cronExpr}"`);
    }
    if (!name || name.trim().length === 0) {
      throw new Error('任務名稱不能為空');
    }
    if (!prompt || prompt.trim().length === 0) {
      throw new Error('Prompt 提示詞不能為空');
    }

    const newTask = {
      id: 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      name: name.trim(),
      cron: cronExpr.trim(),
      prompt: prompt.trim(),
      newSession: newSession !== false,
      enabled: enabled !== false,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastStatus: null
    };

    this.tasks.push(newTask);
    this.saveToFile();

    if (newTask.enabled) {
      this.registerJob(newTask);
    }

    return newTask;
  }

  /**
   * 動態刪除排程任務
   */
  deleteTask(taskId) {
    const idx = this.tasks.findIndex(t => t.id === taskId);
    if (idx === -1) {
      return false;
    }

    this.stopJob(taskId);
    const removed = this.tasks.splice(idx, 1)[0];
    this.saveToFile();
    return removed;
  }

  /**
   * 切換任務啟用/停用狀態
   */
  toggleTask(taskId, targetEnabled) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return null;

    task.enabled = targetEnabled !== undefined ? targetEnabled : !task.enabled;
    this.saveToFile();

    if (task.enabled) {
      this.registerJob(task);
    } else {
      this.stopJob(task.id);
    }

    return task;
  }

  /**
   * 取得所有任務詳細清單（附加下次執行時間）
   */
  getTaskList() {
    return this.tasks.map(t => {
      const job = this.jobs.get(t.id);
      let nextRun = null;
      if (job && typeof job.getNextRun === 'function') {
        try {
          const nr = job.getNextRun();
          if (nr) {
            nextRun = new Date(nr).toLocaleString('zh-TW', { timeZone: DEFAULT_TIMEZONE, hour12: false });
          }
        } catch { }
      }

      return {
        ...t,
        nextRun
      };
    });
  }

  /**
   * 手動重新載入並重啟排程
   */
  reload() {
    this.loadFromFile();
    this.startAllJobs();
  }
}

/**
 * 本地中文時間與頻率解析（快速規則路徑）
 */
function parseChineseTime(text) {
  let cleaned = text.trim();
  let weekPart = '*';
  let hourPart = '0';
  let minPart = '0';

  // 1. 間隔小時: 每隔 N 小時 / 每 N 小時
  const intervalMatch = cleaned.match(/每[隔]?\s*(\d+)\s*(個?小時|hr|h)/i);
  if (intervalMatch) {
    const hours = parseInt(intervalMatch[1], 10);
    return {
      cron: `0 */${hours} * * *`,
      cleanText: cleaned.replace(intervalMatch[0], '').trim()
    };
  }

  // 每小時
  if (/每[個]?小時/.test(cleaned)) {
    return {
      cron: '0 * * * *',
      cleanText: cleaned.replace(/每[個]?小時/, '').trim()
    };
  }

  // 2. 頻率判定
  if (/(工作日|平日|禮拜一[到至及和、\-\s]*[禮拜]*[五5]|週一[到至及和、\-\s]*[週]*[五5]|星期一[到至及和、\-\s]*[星期]*[五5]|每[週周禮拜星期]+[一1][到至及和、\-\s]*[週周禮拜星期]*[五5])/.test(cleaned)) {
    weekPart = '1-5';
    cleaned = cleaned.replace(/(每個?|每逢?)?(工作日|平日|禮拜一[到至及和、\-\s]*[禮拜]*[五5]|週一[到至及和、\-\s]*[週]*[五5]|星期一[到至及和、\-\s]*[星期]*[五5]|每[週周禮拜星期]+[一1][到至及和、\-\s]*[週周禮拜星期]*[五5])/g, '');
  } else if (/每[週周禮拜星期]+([一二三四五六日天1-7])/.test(cleaned)) {
    const wm = cleaned.match(/每[週周禮拜星期]+([一二三四五六日天1-7])/);
    const map = { '一': '1', '1': '1', '二': '2', '2': '2', '三': '3', '3': '3', '四': '4', '4': '4', '五': '5', '5': '5', '六': '6', '6': '6', '日': '0', '天': '0', '7': '0' };
    weekPart = map[wm[1]] || '*';
    cleaned = cleaned.replace(wm[0], '');
  } else if (/每[天日]/.test(cleaned)) {
    weekPart = '*';
    cleaned = cleaned.replace(/每[天日]/g, '');
  }

  // 3. 時間與時段修飾
  let isPm = false;
  let isAm = false;
  if (/(下午|晚上|晚間|傍晚|夜盤|夜間|收盤後|盤後)/.test(cleaned)) {
    isPm = true;
    cleaned = cleaned.replace(/(下午|晚上|晚間|傍晚|夜盤|夜間|收盤後|盤後)/g, '');
  } else if (/(早上|早晨|上午|凌晨|清晨|盤前)/.test(cleaned)) {
    isAm = true;
    cleaned = cleaned.replace(/(早上|早晨|上午|凌晨|清晨|盤前)/g, '');
  }

  // 尋找具體時間: 18:00 / 8:30 或 6點半 / 6點 / 6點00分
  const colonMatch = cleaned.match(/(\d{1,2})[:：](\d{1,2})/);
  const oclockMatch = cleaned.match(/(\d{1,2})\s*點(\s*半|\s*整|\s*\d{1,2}分?)?/);

  if (colonMatch) {
    let h = parseInt(colonMatch[1], 10);
    let m = parseInt(colonMatch[2], 10);
    if (isPm && h < 12) h += 12;
    if (isAm && h === 12) h = 0;
    hourPart = String(h);
    minPart = String(m);
    cleaned = cleaned.replace(colonMatch[0], '');
  } else if (oclockMatch) {
    let h = parseInt(oclockMatch[1], 10);
    let m = 0;
    const mStr = (oclockMatch[2] || '').trim();
    if (mStr.includes('半')) {
      m = 30;
    } else if (/\d+/.test(mStr)) {
      m = parseInt(mStr.match(/\d+/)[0], 10);
    }
    if (isPm && h < 12) h += 12;
    if (isAm && h === 12) h = 0;
    hourPart = String(h);
    minPart = String(m);
    cleaned = cleaned.replace(oclockMatch[0], '');
  } else {
    return null;
  }

  const cronExpr = `${minPart} ${hourPart} * * ${weekPart}`;
  cleaned = cleaned.replace(/^(幫我|請|自動|執行|去)?\s*/g, '').trim();

  return { cron: cronExpr, cleanText: cleaned };
}

/**
 * 快速自然語言排程解析（規則路徑）
 */
function parseScheduleFast(rawText) {
  const parsed = parseChineseTime(rawText);
  if (!parsed || !cron.validate(parsed.cron)) return null;

  const prompt = parsed.cleanText.length > 0 ? parsed.cleanText : rawText;
  const name = parsed.cleanText.length > 0
    ? (parsed.cleanText.length > 15 ? parsed.cleanText.slice(0, 15) : parsed.cleanText)
    : '自然語言排程';

  return {
    name,
    cron: parsed.cron,
    prompt,
    source: 'fast_rule'
  };
}

/**
 * 計算指定 Cron 的下次執行時間（台灣時間）
 */
function calculateNextRun(cronExpr) {
  try {
    if (!cron.validate(cronExpr)) return null;
    const dummy = cron.schedule(cronExpr, () => {}, { timezone: DEFAULT_TIMEZONE });
    const nr = dummy.getNextRun ? dummy.getNextRun() : null;
    dummy.stop();
    if (typeof dummy.destroy === 'function') dummy.destroy();
    if (nr) {
      return new Date(nr).toLocaleString('zh-TW', { timeZone: DEFAULT_TIMEZONE, hour12: false });
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  SchedulerManager,
  DEFAULT_TIMEZONE,
  parseChineseTime,
  parseScheduleFast,
  calculateNextRun
};

