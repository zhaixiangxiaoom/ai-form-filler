// Background service worker for FormPilot extension
importScripts('assets.js');

// Default configuration
const DEFAULT_CONFIG = {
  apiKey: '',
  aiProvider: 'bailian', // bailian, openai, custom
  apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  model: 'qwen-plus',
  autoFill: false,
  language: 'zh'
};

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('FormPilot installed');
  
  // Set default configuration
  chrome.storage.sync.get(['config'], (result) => {
    if (!result.config) {
      chrome.storage.sync.set({ config: DEFAULT_CONFIG });
    }
  });
  
  // Clicking the toolbar icon opens the side panel (main UI)
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  
  // Context menu entry
  if (chrome.contextMenus && chrome.contextMenus.create) {
    chrome.contextMenus.create({
      id: 'formpilot-smart-fill',
      title: '⚡ FormPilot 智能填充',
      contexts: ['page']
    });
  }
});

// Context menu click -> smart fill the current tab
if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'formpilot-smart-fill' && tab && tab.id) {
      smartFillTab(tab.id);
    }
  });
}

// Keyboard shortcut (Alt+Shift+F) -> smart fill the active tab
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'smart-fill') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) smartFillTab(tab.id);
    }
  });
}

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getConfig') {
    chrome.storage.sync.get(['config'], (result) => {
      sendResponse(result.config || DEFAULT_CONFIG);
    });
    return true;
  }
  
  if (message.action === 'updateConfig') {
    chrome.storage.sync.set({ config: message.config }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
  
  if (message.action === 'generateFormData') {
    handleGenerateFormData(message.fields, message.context, { regenerate: !!message.regenerate })
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep message channel open for async response
  }
  
  // ==================== P3: batch fill & asset import ====================
  
  if (message.action === 'batchFill') {
    (async () => {
      const tabId = message.tabId;
      const det = await chrome.tabs.sendMessage(tabId, { action: 'detectBatchRows' });
      if (!det || !det.rows || det.rows.length < 2) {
        return { success: false, error: '未检测到可批量填充的重复行（表格行/重复块）' };
      }
      const context = det.context || {};
      const rowsData = [];
      for (const row of det.rows) {
        if (!row.fields || row.fields.length === 0) { rowsData.push({}); continue; }
        // Each row gets fresh values: skip template/persona reuse sources
        const gen = await handleGenerateFormData(row.fields, context, { regenerate: true });
        rowsData.push(gen.data || {});
      }
      const report = await chrome.tabs.sendMessage(tabId, { action: 'fillBatch', rowsData });
      return { success: true, report: report || {}, rowCount: det.rows.length };
    })()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'importAssets') {
    (async () => {
      const p = message.payload || {};
      const assets = await loadAssets();
      const merge = (list, incoming) => {
        const stat = { added: 0, updated: 0 };
        (incoming || []).forEach(item => {
          if (!item || !item.id) return;
          const idx = list.findIndex(x => x.id === item.id);
          if (idx >= 0) { list[idx] = item; stat.updated++; }
          else { list.push(item); stat.added++; }
        });
        return stat;
      };
      const counts = {
        personas: merge(assets.personas, p.personas),
        templates: merge(assets.templates, p.templates),
        rules: merge(assets.rules, p.rules)
      };
      if (p.activePersonaId && !assets.activePersonaId) assets.activePersonaId = p.activePersonaId;
      await saveAssets(assets);
      return { success: true, counts };
    })()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  if (message.action === 'smartFill') {
    (async () => {
      if (message.tabId) return smartFillTab(message.tabId);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return { success: false, error: 'No active tab' };
      return smartFillTab(tab.id);
    })()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  // ==================== Data assets CRUD ====================
  
  if (message.action === 'getAssets') {
    loadAssets().then(assets => sendResponse(assets));
    return true;
  }
  
  if (message.action === 'savePersona') {
    (async () => {
      const assets = await loadAssets();
      const persona = message.persona;
      const idx = assets.personas.findIndex(p => p.id === persona.id);
      if (idx >= 0) assets.personas[idx] = persona;
      else assets.personas.push(persona);
      if (!assets.activePersonaId) assets.activePersonaId = persona.id;
      await saveAssets(assets);
      return { success: true };
    })().then(sendResponse);
    return true;
  }
  
  if (message.action === 'deletePersona') {
    (async () => {
      const assets = await loadAssets();
      assets.personas = assets.personas.filter(p => p.id !== message.id);
      if (assets.activePersonaId === message.id) {
        assets.activePersonaId = assets.personas.length > 0 ? assets.personas[0].id : null;
      }
      await saveAssets(assets);
      return { success: true };
    })().then(sendResponse);
    return true;
  }
  
  if (message.action === 'setActivePersona') {
    (async () => {
      const assets = await loadAssets();
      assets.activePersonaId = message.id || null;
      await saveAssets(assets);
      return { success: true };
    })().then(sendResponse);
    return true;
  }
  
  if (message.action === 'createRandomPersona') {
    (async () => {
      const config = await new Promise((resolve) => {
        chrome.storage.sync.get(['config'], (result) => resolve(result.config || DEFAULT_CONFIG));
      });
      const persona = buildRandomPersona(config.language);
      const assets = await loadAssets();
      assets.personas.push(persona);
      if (!assets.activePersonaId) assets.activePersonaId = persona.id;
      await saveAssets(assets);
      return { success: true, persona };
    })().then(sendResponse);
    return true;
  }
  
  if (message.action === 'saveTemplate') {
    (async () => {
      const assets = await loadAssets();
      const domain = message.domain;
      const data = message.data || {};
      const semanticData = {};
      (message.fields || []).forEach(f => {
        if (data[f.name] !== undefined) semanticData[classifyField(f)] = data[f.name];
      });
      const existing = assets.templates.find(t => t.domain === domain);
      if (existing) {
        existing.data = data;
        existing.semanticData = semanticData;
        existing.updatedAt = Date.now();
      } else {
        assets.templates.push({
          id: uid('tpl'),
          domain,
          data,
          semanticData,
          usageCount: 0,
          createdAt: Date.now()
        });
      }
      await saveAssets(assets);
      return { success: true };
    })().then(sendResponse);
    return true;
  }
  
  if (message.action === 'deleteTemplate') {
    (async () => {
      const assets = await loadAssets();
      assets.templates = assets.templates.filter(t => t.id !== message.id);
      await saveAssets(assets);
      return { success: true };
    })().then(sendResponse);
    return true;
  }
  
  if (message.action === 'saveRule') {
    (async () => {
      const assets = await loadAssets();
      assets.rules.push(message.rule);
      await saveAssets(assets);
      return { success: true };
    })().then(sendResponse);
    return true;
  }
  
  if (message.action === 'deleteRule') {
    (async () => {
      const assets = await loadAssets();
      assets.rules = assets.rules.filter(r => r.id !== message.id);
      await saveAssets(assets);
      return { success: true };
    })().then(sendResponse);
    return true;
  }
  
  // Save user corrections as domain-scoped rules (learning loop)
  if (message.action === 'saveCorrectionRules') {
    (async () => {
      const assets = await loadAssets();
      const fieldMap = {};
      (message.fields || []).forEach(f => { fieldMap[f.name] = f; });
      (message.corrections || []).forEach(cor => {
        const field = fieldMap[cor.name];
        const semantic = field ? classifyField(field) : 'text';
        const useSemantic = semantic !== 'text' && semantic !== 'longtext' && semantic !== 'richtext';
        const matchType = useSemantic ? 'semantic' : 'name';
        const matchValue = useSemantic ? semantic : cor.name;
        // Replace any existing rule with the same match on this domain
        assets.rules = assets.rules.filter(r =>
          !(r.scope === 'domain' && r.domain === message.domain &&
            r.matchType === matchType && r.matchValue === matchValue));
        assets.rules.push({
          id: uid('rule'),
          scope: 'domain',
          domain: message.domain,
          matchType,
          matchValue,
          value: cor.value,
          enabled: true,
          learned: true,
          createdAt: Date.now()
        });
      });
      await saveAssets(assets);
      return { success: true };
    })().then(sendResponse);
    return true;
  }
  
  if (message.action === 'fillForm') {
    // Forward fill command to content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'fillForm',
          formData: message.formData
        });
      }
    });
    sendResponse({ success: true });
  }
});

// Promise wrapper for tab messaging
function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Full smart-fill orchestration: detect -> hybrid generate -> fill -> report
async function smartFillTab(tabId) {
  const detect = await sendTabMessage(tabId, { action: 'detectForms' });
  if (!detect || !detect.forms || detect.forms.length === 0) {
    return { success: false, error: '没有检测到表单' };
  }
  
  const fields = [];
  detect.forms.forEach(form => fields.push(...form.fields));
  const context = detect.forms[0] ? detect.forms[0].context : null;
  
  const gen = await handleGenerateFormData(fields, context);
  const data = gen.data || {};
  if (Object.keys(data).length === 0) {
    return { success: false, error: '无可填充字段。开放性字段需要在设置中配置 API Key。' };
  }
  
  const report = await sendTabMessage(tabId, { action: 'fillForm', formData: data });
  return {
    success: true,
    data: data,
    report: report || {},
    stats: gen.stats,
    aiError: gen.aiError
  };
}

// Generate form data using hybrid engine with data-asset priority:
// user rules > site template > active persona > rule engine > AI
// options.regenerate (single-field 🔄) skips reuse sources (template/persona)
// so the user always gets a fresh value; explicit user rules still apply.
async function handleGenerateFormData(fields, context, options) {
  const config = await new Promise((resolve) => {
    chrome.storage.sync.get(['config'], (result) => {
      resolve(result.config || DEFAULT_CONFIG);
    });
  });
  
  const language = config.language || 'zh';
  const opts = options || {};
  const assets = await loadAssets();
  const domain = context && context.url ? domainOf(context.url) : '';
  const template = (!opts.regenerate && domain) ? assets.templates.find(t => t.domain === domain) : null;
  const persona = (!opts.regenerate) ? (assets.personas.find(p => p.id === assets.activePersonaId) || null) : null;
  
  const data = {};
  const aiFields = [];
  let templateHits = 0;
  
  // Pass 1: deterministic sources (rules / template / persona / rule engine)
  fields.forEach(field => {
    const semantic = classifyField(field);
    
    // 1) User custom rules
    const rule = matchRule(assets.rules, field, semantic, domain);
    if (rule) {
      data[field.name] = rule.value;
      return;
    }
    
    // 2) Site-saved template (by field name, then by semantic)
    if (template) {
      if (template.data && field.name in template.data) {
        data[field.name] = template.data[field.name];
        templateHits++;
        return;
      }
      if (template.semanticData && semantic in template.semanticData) {
        data[field.name] = template.semanticData[semantic];
        templateHits++;
        return;
      }
    }
    
    // 3) Active persona (skip generic date fields to avoid misusing birthday)
    if (persona && persona.fields && semantic in persona.fields && semantic !== 'date') {
      data[field.name] = fitLength(persona.fields[semantic], field.constraints || {});
      return;
    }
    
    // 4) Rule engine
    const value = generateByRules(field, semantic, language);
    if (value !== null) {
      data[field.name] = value;
    } else {
      aiFields.push(Object.assign({}, field, { semantic }));
    }
  });
  
  // Bump template usage stats
  if (template && templateHits > 0) {
    template.usageCount = (template.usageCount || 0) + 1;
    template.lastUsedAt = Date.now();
    saveAssets(assets);
  }
  
  // Pass 2: open-ended fields go to AI
  let aiData = {};
  let aiError = null;
  if (aiFields.length > 0) {
    if (!config.apiKey) {
      aiError = 'API key not configured - open-ended fields were skipped.';
    } else {
      try {
        aiData = await callAIForFields(aiFields, context, config);
      } catch (error) {
        console.error('AI generation error:', error);
        aiError = error.message;
      }
    }
  }
  
  return {
    success: true,
    data: Object.assign({}, data, aiData),
    stats: {
      totalFields: fields.length,
      ruleCount: Object.keys(data).length,
      aiCount: Object.keys(aiData).length,
      templateUsed: templateHits > 0,
      personaUsed: !!persona,
      skippedFields: aiFields.map(f => f.name).filter(n => !(n in aiData))
    },
    aiError
  };
}

// Call AI for a set of open-ended fields and parse the JSON response
async function callAIForFields(aiFields, context, config) {
  const prompt = buildAIPrompt(aiFields, context, config.language);
  const maxTokens = Math.min(4000, 500 + aiFields.length * 400);
  
  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: '你是一个专业的表单数据填写助手。你理解表单的业务场景，生成符合字段要求的内容。只返回有效的JSON格式，不要包含markdown格式或解释。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: maxTokens
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || 'AI API request failed');
  }
  
  const data = await response.json();
  const content = data.choices[0].message.content.trim();
  
  try {
    // Remove markdown code blocks if present
    const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    return JSON.parse(jsonStr);
  } catch (parseError) {
    console.error('Failed to parse AI response:', content);
    throw new Error('Failed to parse AI response as JSON');
  }
}

// ==================== Field semantic classifier ====================

// Classify a field into a semantic type based on input type and name/label hints
function classifyField(field) {
  const type = (field.type || '').toLowerCase();
  const hint = [field.name, field.label, field.placeholder, field.id]
    .filter(Boolean).join(' ').toLowerCase();
  
  if (type.startsWith('richtext')) return 'richtext';
  if (type === 'custom-select') return 'choice';
  if (type === 'email') return 'email';
  if (type === 'tel') return 'phone';
  if (type === 'url') return 'url';
  if (type === 'date' || type === 'datetime-local' || type === 'month') return 'date';
  if (type === 'time') return 'time';
  if (type === 'number' || type === 'range') return 'number';
  if (type === 'password') return 'password';
  if (field.tagName === 'select' || type === 'radio') return 'choice';
  if (type === 'checkbox') return 'boolean';
  
  // Keyword-based classification (order matters: specific before generic)
  const rules = [
    ['email', /e-?mail|邮箱|邮件/],
    ['phone', /phone|mobile|tel|手机|电话|联系方式/],
    ['url', /url|website|网址|链接|homepage|blog/],
    ['zipcode', /zip|postal|邮编/],
    ['date', /date|birth|birthday|日期|生日|出生/],
    ['number', /age|年龄|数量|金额|qty|quantity|amount/],
    ['address', /address|地址|addr|街道/],
    ['city', /city|城市/],
    ['company', /company|公司|单位|企业|employer|组织|机构/],
    ['username', /username|user_?id|用户名|账号|account|login/],
    ['name', /name|姓名|名字|称呼|联系人/]
  ];
  for (const [semantic, re] of rules) {
    if (re.test(hint)) return semantic;
  }
  
  if (field.tagName === 'textarea') return 'longtext';
  return 'text';
}

// ==================== Rule engine ====================

const DATA_POOL = {
  domains: ['example.com', 'testmail.cn', 'sample.org', 'demo.net'],
  zhSurnames: ['张', '王', '李', '赵', '刘', '陈', '杨', '黄', '周', '吴'],
  zhGiven: ['伟', '芳', '娜', '敏', '静', '磊', '军', '洋', '勇', '艳', '杰', '娟', '涛', '明', '超'],
  enFirst: ['James', 'Mary', 'John', 'Emma', 'David', 'Sophia', 'Michael', 'Olivia'],
  enLast: ['Smith', 'Johnson', 'Brown', 'Davis', 'Wilson', 'Taylor', 'Clark', 'Lewis'],
  zhCities: ['北京市', '上海市', '杭州市', '深圳市', '广州市', '成都市', '南京市', '武汉市'],
  zhStreets: ['中山路', '人民路', '解放路', '建设路', '文化路', '和平路', '光明路'],
  zhCompanyPrefix: ['星辰', '蓝海', '华信', '瑞达', '天翼', '中科', '远大', '宏图'],
  zhCompanyIndustry: ['科技', '网络', '信息', '智能', '数据', '传媒', '咨询'],
  zhCompanySuffix: ['有限公司', '股份有限公司', '集团', '工作室'],
  words: ['smart', 'happy', 'sunny', 'quick', 'blue', 'green', 'silver', 'golden', 'brave', 'calm']
};

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += randInt(0, 9);
  return s;
}

// Enforce minlength/maxlength constraints on a string value
function fitLength(value, constraints) {
  const c = constraints || {};
  const maxLen = parseInt(c.maxlength, 10);
  const minLen = parseInt(c.minlength, 10);
  let v = String(value);
  if (!isNaN(maxLen) && v.length > maxLen) v = v.slice(0, maxLen);
  if (!isNaN(minLen) && v.length < minLen) v = v.padEnd(minLen, '0');
  return v;
}

// Generate a value locally; return null when the field must be handled by AI
function generateByRules(field, semantic, language) {
  const c = field.constraints || {};
  const isZh = language === 'zh';
  
  switch (semantic) {
    case 'choice': {
      // Pick a random valid option (skip empty placeholder options)
      const options = (field.options || []).filter(o => {
        const v = typeof o === 'object' ? o.value : o;
        return v !== '' && v !== null && v !== undefined;
      });
      if (options.length === 0) return null;
      const picked = rand(options);
      return typeof picked === 'object' ? picked.value : picked;
    }
    
    case 'boolean':
      // Most agreement/subscribe boxes: usually checked
      return Math.random() < 0.7;
    
    case 'email':
      return fitLength(`${rand(DATA_POOL.words)}.${rand(DATA_POOL.words)}${randInt(1, 99)}@${rand(DATA_POOL.domains)}`, c);
    
    case 'phone':
      return isZh
        ? '1' + rand(['3', '5', '6', '7', '8', '9']) + randDigits(9)
        : '+1' + randDigits(10);
    
    case 'url':
      return `https://www.${rand(DATA_POOL.words)}${randInt(1, 99)}.com`;
    
    case 'zipcode':
      return isZh ? randDigits(6) : randDigits(5);
    
    case 'name':
      return isZh
        ? rand(DATA_POOL.zhSurnames) + rand(DATA_POOL.zhGiven) + (Math.random() < 0.5 ? rand(DATA_POOL.zhGiven) : '')
        : `${rand(DATA_POOL.enFirst)} ${rand(DATA_POOL.enLast)}`;
    
    case 'username':
      return fitLength(`${rand(DATA_POOL.words)}_${rand(DATA_POOL.words)}${randInt(10, 999)}`, c);
    
    case 'city':
      return isZh ? rand(DATA_POOL.zhCities) : rand(['New York', 'London', 'Tokyo', 'Paris', 'Berlin']);
    
    case 'address':
      return isZh
        ? `${rand(DATA_POOL.zhCities)}${rand(DATA_POOL.zhStreets)}${randInt(1, 200)}号`
        : `${randInt(1, 999)} Main Street, Springfield`;
    
    case 'company':
      return isZh
        ? `${rand(DATA_POOL.zhCompanyPrefix)}${rand(DATA_POOL.zhCompanyIndustry)}${rand(DATA_POOL.zhCompanySuffix)}`
        : `${rand(DATA_POOL.words).charAt(0).toUpperCase() + rand(DATA_POOL.words).slice(1)} Technologies Inc.`;
    
    case 'number':
      return generateNumber(c);
    
    case 'date':
    case 'time':
      return generateDate(field, c);
    
    case 'password':
      return generatePassword(c);
    
    default:
      // text / longtext / richtext / unknown -> AI handles it
      return null;
  }
}

// Generate a number respecting min/max/step
function generateNumber(c) {
  const min = c.min !== '' && !isNaN(parseFloat(c.min)) ? parseFloat(c.min) : 0;
  const max = c.max !== '' && !isNaN(parseFloat(c.max)) ? parseFloat(c.max) : Math.max(min + 100, 100);
  const step = c.step !== '' && !isNaN(parseFloat(c.step)) && parseFloat(c.step) > 0 ? parseFloat(c.step) : 1;
  const steps = Math.floor((max - min) / step);
  const value = min + randInt(0, Math.max(steps, 1)) * step;
  // Trim floating point noise
  return Number(value.toFixed(4));
}

// Generate a date/time respecting min/max and birth-date hints
function generateDate(field, c) {
  const type = (field.type || '').toLowerCase();
  const hint = [field.name, field.label].filter(Boolean).join(' ').toLowerCase();
  const isBirth = /birth|生日|出生/.test(hint);
  
  let from, to;
  if (c.min && !isNaN(Date.parse(c.min))) {
    from = new Date(c.min);
  } else {
    from = isBirth ? new Date(1960, 0, 1) : new Date(Date.now() - 365 * 24 * 3600 * 1000);
  }
  if (c.max && !isNaN(Date.parse(c.max))) {
    to = new Date(c.max);
  } else {
    to = isBirth ? new Date(2005, 11, 31) : new Date(Date.now() + 365 * 24 * 3600 * 1000);
  }
  if (to < from) to = from;
  
  const d = new Date(from.getTime() + Math.random() * (to.getTime() - from.getTime()));
  const pad = n => String(n).padStart(2, '0');
  
  if (type === 'month') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (type === 'time') return `${pad(randInt(8, 20))}:${pad(randInt(0, 59))}`;
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (type === 'datetime-local') return `${dateStr}T${pad(randInt(8, 20))}:${pad(randInt(0, 59))}`;
  return dateStr;
}

// Generate a strong random password
function generatePassword(c) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*';
  const maxLen = parseInt(c.maxlength, 10);
  const minLen = parseInt(c.minlength, 10);
  let length = 16;
  if (!isNaN(maxLen)) length = Math.min(length, maxLen);
  if (!isNaN(minLen)) length = Math.max(length, minLen);
  length = Math.max(length, 8);
  
  let pwd = upper[randInt(0, upper.length - 1)] + lower[randInt(0, lower.length - 1)] +
            digits[randInt(0, digits.length - 1)] + symbols[randInt(0, symbols.length - 1)];
  const all = upper + lower + digits + symbols;
  while (pwd.length < length) pwd += all[randInt(0, all.length - 1)];
  return pwd;
}

// Build AI prompt for open-ended fields with full page context and constraints
function buildAIPrompt(fields, context, language) {
  const fieldDescriptions = fields.map(field => {
    const isRichText = field.type && String(field.type).startsWith('richtext');
    const c = field.constraints || {};
    const constraintParts = [];
    if (c.maxlength) constraintParts.push(`maxlength: ${c.maxlength}`);
    if (c.minlength) constraintParts.push(`minlength: ${c.minlength}`);
    if (c.pattern) constraintParts.push(`pattern: ${c.pattern}`);
    
    const info = [
      `- "${field.name}" (type: ${field.type}${isRichText ? ' - RICH TEXT EDITOR, generate HTML content' : ''}`,
      field.semantic ? `semantic: ${field.semantic}` : '',
      field.label ? `label: "${field.label}"` : '',
      field.placeholder ? `placeholder: "${field.placeholder}"` : '',
      field.required ? 'required' : '',
      constraintParts.length ? constraintParts.join(', ') : '',
      field.options ? `options: [${(field.options || []).map(o => typeof o === 'object' ? o.text || o.value : o).join(', ')}]` : ''
    ].filter(Boolean).join(', ') + ')';
    return info;
  }).join('\n');
  
  const contextLines = [];
  if (context) {
    if (context.title) contextLines.push(`Page title: ${context.title}`);
    if (context.metaDescription) contextLines.push(`Page description: ${context.metaDescription}`);
    if (context.url) contextLines.push(`Page URL: ${context.url}`);
  }
  const contextInfo = contextLines.length ? `\nPage context (use it to understand what this form is for):\n${contextLines.join('\n')}` : '';
  const languageInfo = language === 'zh' ? 'Please generate data in Chinese.' : 'Please generate data in English.';
  
  const hasRichText = fields.some(f => f.type && String(f.type).startsWith('richtext'));
  const richTextInstruction = hasRichText ? `
7. For RICH TEXT EDITOR fields (type starts with "richtext"), generate HTML content with proper formatting:
   - Use <p> for paragraphs, <h2>/<h3> for headings, <strong>/<em> for emphasis, <ul>/<li> for lists
   - Make it look professional and well-formatted` : '';
  
  return `You are filling a real web form. First understand the form's purpose from the page context, then generate content that fits the scenario and each field's constraints.
${contextInfo}

Fields to fill:
${fieldDescriptions}

Requirements:
1. Return a JSON object where keys are EXACTLY the field names above and values are the fill content
2. Content must match the form's business scenario and be coherent across fields
3. Strictly obey each field's constraints (maxlength, minlength, pattern)
4. For select/radio fields, choose ONLY from the provided options
5. For open text fields, write natural, realistic content of appropriate length
6. ${languageInfo}${richTextInstruction}
8. Do NOT include any explanation or markdown, just return the JSON object`;
}
