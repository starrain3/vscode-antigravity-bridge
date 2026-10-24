const fs = require('fs');
const path = require('path');

const DEFAULT_WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(__dirname, '..');

/**
 * 簡易解析 YAML Frontmatter
 * 支援 name, description, prompt 等常見欄位及多行文字 (>- / |)
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const yamlBlock = match[1];
  const result = {};
  const lines = yamlBlock.split(/\r?\n/);

  let currentKey = null;
  let multilineBuffer = [];
  let isFolded = false; // >-
  let isLiteral = false; // |

  const flushBuffer = () => {
    if (currentKey && multilineBuffer.length > 0) {
      if (isFolded) {
        result[currentKey] = multilineBuffer.join(' ').replace(/\s+/g, ' ').trim();
      } else if (isLiteral) {
        result[currentKey] = multilineBuffer.join('\n').trim();
      } else {
        result[currentKey] = multilineBuffer.join(' ').trim();
      }
    }
    multilineBuffer = [];
    isFolded = false;
    isLiteral = false;
  };

  for (const line of lines) {
    const keyMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      flushBuffer();
      currentKey = keyMatch[1];
      const val = keyMatch[2].trim();

      if (val === '>-' || val === '>') {
        isFolded = true;
      } else if (val === '|-' || val === '|') {
        isLiteral = true;
      } else {
        // 去除前後引號
        result[currentKey] = val.replace(/^["'](.*)["']$/, '$1');
        currentKey = null; // 單行直接處理完畢
      }
    } else if (currentKey && /^\s+/.test(line)) {
      multilineBuffer.push(line.trim());
    }
  }

  flushBuffer();
  return result;
}

/**
 * 掃描指定目錄下所有的 SKILL.md
 * @param {string} workspaceRoot 工作區根目錄
 * @returns {Array<Object>} 技能清單
 */
function getWorkspaceSkills(workspaceRoot = DEFAULT_WORKSPACE_ROOT) {
  const skills = [];
  const visitedSkillPaths = new Set();

  const addSkillFromFile = (skillMdPath, fallbackProject = '') => {
    try {
      const realPath = path.resolve(skillMdPath);
      if (visitedSkillPaths.has(realPath)) return;
      if (!fs.existsSync(realPath)) return;

      const content = fs.readFileSync(realPath, 'utf-8');
      const meta = parseFrontmatter(content);
      const folderName = path.basename(path.dirname(realPath));

      const name = meta.name || folderName;
      const description = meta.description || '無描述說明';

      // 計算所屬專案
      const relPath = path.relative(workspaceRoot, realPath).replace(/\\/g, '/');
      let project = fallbackProject;
      if (!project) {
        const parts = relPath.split('/');
        if (parts[0] === '.agent') {
          project = '全域 (Workspace Root)';
        } else {
          project = parts[0];
        }
      }

      // 提取預設執行的 Prompt
      // 1. 若 Frontmatter 有寫 prompt 則採用
      // 2. 否則預設標準 prompt
      // const prompt = meta.prompt || `請依據技能 [${name}] 的規範與工作流程開始執行。`;
      const prompt = `/${name}`;

      // 簡化長度做為 Telegram 描述展示（最多 100 字）
      const shortDesc = description.length > 100 ? description.slice(0, 97) + '...' : description;

      skills.push({
        id: name,
        name,
        project,
        description,
        shortDesc,
        prompt,
        filePath: realPath,
        relPath
      });

      visitedSkillPaths.add(realPath);
    } catch (err) {
      console.warn(`[Skills] 讀取技能檔案出錯 (${skillMdPath}):`, err.message);
    }
  };

  // 1. 探索 .agent/skills.json
  const skillsJsonPath = path.join(workspaceRoot, '.agent', 'skills.json');
  if (fs.existsSync(skillsJsonPath)) {
    try {
      const raw = fs.readFileSync(skillsJsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) {
          if (entry.path) {
            const skillsDir = path.resolve(workspaceRoot, entry.path);
            if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
              const subFolders = fs.readdirSync(skillsDir);
              for (const sub of subFolders) {
                const candidate = path.join(skillsDir, sub, 'SKILL.md');
                if (fs.existsSync(candidate)) {
                  addSkillFromFile(candidate);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[Skills] 解析 .agent/skills.json 失敗:', err.message);
    }
  }

  // 2. 探索全域根目錄 .agent/skills/
  const rootSkillsDir = path.join(workspaceRoot, '.agent', 'skills');
  if (fs.existsSync(rootSkillsDir) && fs.statSync(rootSkillsDir).isDirectory()) {
    try {
      const subFolders = fs.readdirSync(rootSkillsDir);
      for (const sub of subFolders) {
        const candidate = path.join(rootSkillsDir, sub, 'SKILL.md');
        if (fs.existsSync(candidate)) {
          addSkillFromFile(candidate, '全域 (Workspace Root)');
        }
      }
    } catch (err) {
      console.warn('[Skills] 掃描根目錄 skills 失敗:', err.message);
    }
  }

  // 3. 自動掃描各子專案目錄 (如 stock, Money, reader, OIP 等)
  try {
    const rootItems = fs.readdirSync(workspaceRoot);
    const ignoreDirs = new Set(['node_modules', '.git', '.vscode', 'tmp', 'dist', 'build', '.agent']);

    for (const item of rootItems) {
      if (ignoreDirs.has(item)) continue;
      const subProjectPath = path.join(workspaceRoot, item);
      try {
        if (!fs.statSync(subProjectPath).isDirectory()) continue;

        const subAgentSkillsDir = path.join(subProjectPath, '.agent', 'skills');
        if (fs.existsSync(subAgentSkillsDir) && fs.statSync(subAgentSkillsDir).isDirectory()) {
          const subFolders = fs.readdirSync(subAgentSkillsDir);
          for (const sub of subFolders) {
            const candidate = path.join(subAgentSkillsDir, sub, 'SKILL.md');
            if (fs.existsSync(candidate)) {
              addSkillFromFile(candidate, item);
            }
          }
        }
      } catch {
        // 略過不可存取的目錄
      }
    }
  } catch (err) {
    console.warn('[Skills] 掃描子目錄出錯:', err.message);
  }

  return skills;
}

/**
 * 跳脫 Telegram 傳統 Markdown (Markdown v1) 中的特殊字元
 * 特殊字元包含: _ * ` [ \
 * @param {string} text 原始文字
 * @returns {string} 跳脫後的安全字串
 */
function escapeMarkdown(text) {
  if (!text) return '';
  return String(text).replace(/([\\_*`\[])/g, '\\$1');
}

/**
 * 格式化輸出 Telegram 技能清單與按鈕
 * @param {Array<Object>} skills 技能陣列
 * @param {string} projectName 專案名稱
 * @returns {{ text: string, buttons: Array<Array<Object>> }}
 */
function renderSkillsMessage(skills, projectName = 'Workspace') {
  const safeProjectName = String(projectName || 'Workspace').replace(/`/g, "'");

  if (!skills || skills.length === 0) {
    return {
      text: `🛠️ *Antigravity 工作區自定義 Skills 清單*\n` +
        `📁 *工作區*：\`${safeProjectName}\`\n\n` +
        `ℹ️ 目前在當前工作區中未偵測到任何自定義 Skill。\n\n` +
        `💡 *如何新增自定義 Skill*：\n` +
        `在專案或根目錄建立 \`.agent/skills/<skill_name>/SKILL.md\`，並包含 YAML Frontmatter 即可自動生效！`,
      buttons: [[{ text: '🔄 重新整理清單', callback_data: 'skills_refresh' }]]
    };
  }

  let text = `🛠️ *Antigravity 工作區自定義 Skills 清單*\n` +
    `📁 *工作區*：\`${safeProjectName}\` (共 ${skills.length} 個技能)\n\n`;

  const keyboardButtons = [];

  skills.forEach((s, idx) => {
    const safeName = escapeMarkdown(s.name);
    const safeProject = String(s.project || '').replace(/`/g, "'");
    const cleanDesc = (s.shortDesc || '').replace(/\r?\n+/g, ' ').trim();
    const safeDesc = escapeMarkdown(cleanDesc);

    text += `*${idx + 1}. 📦 ${safeName}*\n` +
      `   • 📂 *所屬專案*：\`${safeProject}\`\n` +
      `   • 📝 *說明*：${safeDesc}\n\n`;

    // 每個 Skill 獨立一行專屬按鈕
    keyboardButtons.push([
      { text: `⚡ 執行：${s.name}`, callback_data: `skill_run:${idx}` }
    ]);
  });

  text += `💡 *操作提示*：\n` +
    `• 點擊上方按鈕可一鍵直接指派 Antigravity 執行該 Skill。\n` +
    `• 本機新增或修改 \`SKILL.md\` 後，點擊重新整理即可即時同步。`;

  keyboardButtons.push([
    { text: '🔄 重新整理 Skills 清單', callback_data: 'skills_refresh' }
  ]);

  return { text, buttons: keyboardButtons };
}

module.exports = {
  parseFrontmatter,
  getWorkspaceSkills,
  renderSkillsMessage,
  escapeMarkdown,
  DEFAULT_WORKSPACE_ROOT
};


