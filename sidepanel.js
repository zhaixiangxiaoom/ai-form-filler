// Side panel script for FormPilot - main UI with preview/edit flow

let detectedForms = [];
let allFields = [];
let pageContext = null;
let currentTabId = null;
let values = {}; // fieldName -> generated/edited value
let generatedSnapshot = {}; // values as generated, used to diff user corrections
let currentDomain = '';
let pendingCorrections = [];

// ==================== Messaging helpers ====================

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

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) currentTabId = tab.id;
  return tab;
}

// ==================== Init ====================

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('smart-btn').addEventListener('click', smartFill);
  document.getElementById('detect-btn').addEventListener('click', detectPreview);
  document.getElementById('generate-btn').addEventListener('click', generateAll);
  document.getElementById('fill-btn').addEventListener('click', fillFromEditor);
  document.getElementById('undo-btn').addEventListener('click', undoFill);
  document.getElementById('step-fill-btn').addEventListener('click', () => {
    hideStepBanner();
    smartFill();
  });

  // Tabs
  document.getElementById('tab-fill').addEventListener('click', () => switchTab('fill'));
  document.getElementById('tab-assets').addEventListener('click', () => switchTab('assets'));

  // Template saving & correction learning
  document.getElementById('save-template-btn').addEventListener('click', saveTemplate);
  document.getElementById('learn-save-btn').addEventListener('click', saveLearnedRules);
  document.getElementById('learn-dismiss-btn').addEventListener('click', hideLearnBanner);

  // Persona management
  document.getElementById('persona-add-real').addEventListener('click', () => {
    document.getElementById('persona-form').style.display = 'flex';
  });
  document.getElementById('persona-add-random').addEventListener('click', addRandomPersona);
  document.getElementById('persona-save').addEventListener('click', savePersonaForm);
  document.getElementById('persona-cancel').addEventListener('click', () => {
    document.getElementById('persona-form').style.display = 'none';
  });

  // Rule form
  const SEMANTICS = ['email', 'phone', 'name', 'username', 'company', 'address', 'city', 'zipcode', 'url', 'date', 'number'];
  const semanticSel = document.getElementById('rf-semantic');
  semanticSel.innerHTML = SEMANTICS.map(s => `<option value="${s}">${s}</option>`).join('');
  document.getElementById('rf-match-type').addEventListener('change', (e) => {
    const isSem = e.target.value === 'semantic';
    semanticSel.style.display = isSem ? '' : 'none';
    document.getElementById('rf-match-value').style.display = isSem ? 'none' : '';
  });
  document.getElementById('rule-save').addEventListener('click', addRule);

  // P3: batch fill & backup/share
  document.getElementById('batch-btn').addEventListener('click', batchFill);
  document.getElementById('export-btn').addEventListener('click', exportAssets);
  document.getElementById('import-btn').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', importAssetsFile);
  document.getElementById('share-gen-btn').addEventListener('click', generateShareCode);
  document.getElementById('share-open-btn').addEventListener('click', () => {
    document.getElementById('share-box').style.display = 'block';
    document.getElementById('share-box').value = '';
    document.getElementById('share-import-actions').style.display = 'flex';
  });
  document.getElementById('share-import-btn').addEventListener('click', importShareCode);
  document.getElementById('share-cancel-btn').addEventListener('click', () => {
    document.getElementById('share-box').style.display = 'none';
    document.getElementById('share-import-actions').style.display = 'none';
  });
});

// Listen for multi-step form change notifications from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'formStepChanged') {
    showStepBanner();
  }
});

// ==================== One-click smart fill ====================

async function smartFill() {
  const btn = document.getElementById('smart-btn');
  btn.disabled = true;
  hideReport();
  hideStepBanner();

  try {
    showStatus('⚡ 正在检测表单并生成内容...', 'loading');
    const res = await sendRuntimeMessage({ action: 'smartFill' });

    if (!res || !res.success) {
      showStatus('❌ ' + (res ? res.error : '填充失败'), 'error');
      return;
    }

    // Refresh editor with the values that were filled (for fine-tuning)
    await refreshEditorState(res.data || {});
    displayReport(res);
  } catch (error) {
    showStatus('❌ ' + error.message + '（请刷新页面后重试）', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ==================== Detect + preview/edit flow ====================

async function detectPreview() {
  try {
    showStatus('🔍 正在检测页面表单...', 'loading');
    const tab = await getActiveTab();
    if (!tab) return;

    const response = await sendTabMessage(tab.id, { action: 'detectForms' });
    if (!response || !response.forms || response.forms.length === 0) {
      showStatus('当前页面没有检测到表单', 'info');
      return;
    }

    detectedForms = response.forms;
    allFields = [];
    detectedForms.forEach(form => allFields.push(...form.fields));
    pageContext = detectedForms[0] ? detectedForms[0].context : null;
    currentDomain = domainOfUrl(tab.url);
    values = {};

    renderEditor();
    checkTemplateBanner();
    checkBatchRows();
    showStatus(`✅ 检测到 ${detectedForms.length} 个表单，共 ${allFields.length} 个字段。点击「🧠 生成内容」开始`, 'success');
  } catch (error) {
    showStatus('❌ 无法连接页面，请刷新页面后重试', 'error');
  }
}

// Render editable field cards
function renderEditor() {
  const section = document.getElementById('editor-section');
  const editor = document.getElementById('field-editor');
  editor.innerHTML = '';

  allFields.forEach(field => {
    const card = document.createElement('div');
    card.className = 'field-card';

    const isLong = field.tagName === 'textarea' ||
      (field.type && String(field.type).startsWith('richtext'));
    // Display title priority: page label > placeholder > friendly type name (never show fp_N)
    const displayName = field.label || field.placeholder || friendlyTypeName(field);
    const current = values[field.name] !== undefined ? values[field.name] : '';
    const displayValue = typeof current === 'boolean' ? String(current) : String(current);

    card.innerHTML = `
      <div class="field-head">
        <span class="field-label" title="${escapeHtml(field.name)}">
          ${escapeHtml(displayName)}${field.required ? '<span class="required">*</span>' : ''}
        </span>
        <span class="field-type">${escapeHtml(field.type)}</span>
        <button class="regen-btn" data-name="${escapeHtml(field.name)}" title="重新生成该字段">🔄</button>
      </div>
    `;

    const input = isLong ? document.createElement('textarea') : document.createElement('input');
    input.className = 'field-value';
    input.dataset.name = field.name;
    input.value = displayValue;
    if (!isLong) {
      input.type = 'text';
      if (field.placeholder) input.placeholder = field.placeholder;
    }
    input.addEventListener('input', () => {
      values[field.name] = input.value;
    });
    card.appendChild(input);
    editor.appendChild(card);
  });

  // Regenerate buttons
  editor.querySelectorAll('.regen-btn').forEach(btn => {
    btn.addEventListener('click', () => regenerateField(btn.dataset.name, btn));
  });

  section.style.display = 'block';
  document.getElementById('fill-btn').disabled = Object.keys(values).length === 0;
}

// Generate values for all fields (hybrid engine)
async function generateAll() {
  if (allFields.length === 0) return;
  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  showStatus('🧠 正在生成填充内容（规则引擎 + AI）...', 'loading');

  try {
    const gen = await sendRuntimeMessage({
      action: 'generateFormData',
      fields: allFields,
      context: pageContext
    });

    if (gen.error) {
      showStatus('❌ ' + gen.error, 'error');
      return;
    }

    values = Object.assign({}, gen.data || {});
    generatedSnapshot = Object.assign({}, values);
    syncEditorInputs();
    document.getElementById('fill-btn').disabled = false;

    const stats = gen.stats || {};
    let msg = `✅ 已生成 ${Object.keys(values).length} 个字段内容（规则 ${stats.ruleCount ?? 0} · AI ${stats.aiCount ?? 0}），可编辑后点击「✍️ 填入页面」`;
    if (gen.aiError) msg += '。⚠️ ' + gen.aiError;
    showStatus(msg, gen.aiError ? 'loading' : 'success');
  } catch (error) {
    showStatus('❌ ' + error.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// Regenerate a single field
async function regenerateField(name, btn) {
  const field = allFields.find(f => f.name === name);
  if (!field) return;

  btn.disabled = true;
  try {
    const gen = await sendRuntimeMessage({
      action: 'generateFormData',
      fields: [field],
      context: pageContext,
      regenerate: true // 🔄 means "give me a different value": skip template/persona
    });
    const newValue = gen.data ? gen.data[name] : undefined;
    if (newValue !== undefined) {
      values[name] = newValue;
      generatedSnapshot[name] = newValue;
      const input = document.querySelector(`.field-value[data-name="${cssEscape(name)}"]`);
      if (input) input.value = typeof newValue === 'boolean' ? String(newValue) : newValue;
      showStatus(`🔄 已重新生成「${field.label || name}」`, 'success');
    } else {
      showStatus(`⚠️ 「${field.label || name}」无法重新生成`, 'info');
    }
  } catch (error) {
    showStatus('❌ 重新生成失败: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// Fill page with the edited values
async function fillFromEditor() {
  if (Object.keys(values).length === 0 || !currentTabId) return;
  const btn = document.getElementById('fill-btn');
  btn.disabled = true;
  hideReport();
  showStatus('✍️ 正在填入页面...', 'loading');

  // Diff user edits against the generated snapshot (correction learning)
  pendingCorrections = [];
  allFields.forEach(f => {
    const gen = generatedSnapshot[f.name];
    const cur = values[f.name];
    if (gen !== undefined && cur !== undefined && String(gen) !== String(cur)) {
      pendingCorrections.push({ name: f.name, value: cur, label: f.label });
    }
  });

  try {
    const report = await sendTabMessage(currentTabId, {
      action: 'fillForm',
      formData: values
    });
    displayReport({ report: report || {}, stats: {} });
    if (pendingCorrections.length > 0 && report && report.filledCount > 0) {
      document.getElementById('learn-banner-text').textContent =
        `✏️ 您手动修正了 ${pendingCorrections.length} 个字段，是否记住偏好？`;
      document.getElementById('learn-banner').style.display = 'flex';
    }
  } catch (error) {
    showStatus('❌ 填充失败: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// After one-click fill, load detection + filled values into the editor
async function refreshEditorState(filledData) {
  try {
    const tab = await getActiveTab();
    if (!tab) return;
    const response = await sendTabMessage(tab.id, { action: 'detectForms' });
    if (!response || !response.forms) return;

    detectedForms = response.forms;
    allFields = [];
    detectedForms.forEach(form => allFields.push(...form.fields));
    pageContext = detectedForms[0] ? detectedForms[0].context : null;
    currentDomain = domainOfUrl(tab.url);
    values = Object.assign({}, filledData);
    generatedSnapshot = Object.assign({}, filledData);
    renderEditor();
    checkTemplateBanner();
    checkBatchRows();
  } catch (e) {
    // Editor refresh is best-effort only
  }
}

// Sync editor input boxes with current values
function syncEditorInputs() {
  allFields.forEach(field => {
    const input = document.querySelector(`.field-value[data-name="${cssEscape(field.name)}"]`);
    if (input && values[field.name] !== undefined) {
      input.value = typeof values[field.name] === 'boolean' ? String(values[field.name]) : values[field.name];
    }
  });
}

// ==================== Report & undo ====================

function displayReport(res) {
  const section = document.getElementById('report-section');
  const content = document.getElementById('report-content');
  const report = res.report || {};
  const stats = res.stats || {};
  const invalidFields = report.invalidFields || [];
  const notFound = report.notFound || [];
  const skipped = stats.skippedFields || [];

  let html = `
    <div class="report-summary ${invalidFields.length === 0 ? 'ok' : 'warn'}">
      ✅ 已填充 ${report.filledCount ?? 0} 个字段
      ${(stats.ruleCount !== undefined || stats.aiCount !== undefined)
        ? `（🧩 规则 ${stats.ruleCount ?? 0} · 🤖 AI ${stats.aiCount ?? 0}${stats.templateUsed ? ' · ⭐ 模板' : ''}${stats.personaUsed ? ' · 🎭 人设' : ''}）` : ''}
    </div>
  `;

  if (invalidFields.length > 0) {
    html += `<div class="report-group-title">⚠️ ${invalidFields.length} 个字段未通过页面校验：</div>`;
    invalidFields.forEach(f => {
      html += `
        <div class="report-item invalid">
          <div class="report-field-name">${escapeHtml(f.label || f.name)}</div>
          <div class="report-field-msg">${escapeHtml(f.message)}</div>
        </div>
      `;
    });
    html += `<div class="report-item muted">💡 可在上方编辑器中修改对应字段后重新「✍️ 填入页面」</div>`;
  }

  if (notFound.length > 0) {
    html += `<div class="report-group-title">🔍 ${notFound.length} 个字段未在页面匹配到：</div>`;
    html += `<div class="report-item muted">${escapeHtml(notFound.join(', '))}</div>`;
  }

  if (skipped.length > 0) {
    html += `<div class="report-group-title">⏭️ ${skipped.length} 个开放性字段被跳过：</div>`;
    html += `<div class="report-item muted">${escapeHtml(skipped.join(', '))}<br>` +
      `${res.aiError ? escapeHtml(res.aiError) : 'AI 未返回这些字段'}</div>`;
  }

  content.innerHTML = html;
  section.style.display = 'block';

  const undoBtn = document.getElementById('undo-btn');
  undoBtn.style.display = report.canUndo ? 'block' : 'none';
  document.getElementById('save-template-btn').style.display =
    (report.filledCount > 0 && currentDomain) ? 'block' : 'none';

  if (invalidFields.length > 0) {
    showStatus(`⚠️ 已填充 ${report.filledCount} 个字段，${invalidFields.length} 个未通过校验`, 'error');
  } else {
    showStatus(`✅ 填充完成！共 ${report.filledCount} 个字段`, 'success');
  }
}

function hideReport() {
  document.getElementById('report-section').style.display = 'none';
  document.getElementById('undo-btn').style.display = 'none';
  document.getElementById('save-template-btn').style.display = 'none';
  hideLearnBanner();
}

async function undoFill() {
  if (!currentTabId) return;
  try {
    const response = await sendTabMessage(currentTabId, { action: 'undoFill' });
    if (response && response.success) {
      showStatus(`↩️ 已恢复 ${response.restoredCount} 个字段的原始值`, 'success');
      hideReport();
    } else {
      showStatus((response && response.error) || '没有可撤销的填充', 'info');
    }
  } catch (error) {
    showStatus('撤销失败: ' + error.message, 'error');
  }
}

// ==================== Multi-step banner ====================

function showStepBanner() {
  document.getElementById('step-banner').style.display = 'flex';
}

function hideStepBanner() {
  document.getElementById('step-banner').style.display = 'none';
}

// ==================== P2: tabs, templates & learning ====================

function switchTab(name) {
  document.getElementById('tab-fill').classList.toggle('active', name === 'fill');
  document.getElementById('tab-assets').classList.toggle('active', name === 'assets');
  document.getElementById('fill-tab').classList.toggle('active', name === 'fill');
  document.getElementById('assets-tab').classList.toggle('active', name === 'assets');
  if (name === 'assets') loadAssetsUI();
}

// Show a banner when the current site has a saved template
async function checkTemplateBanner() {
  const banner = document.getElementById('template-banner');
  if (!currentDomain) { banner.style.display = 'none'; return; }
  try {
    const assets = await sendRuntimeMessage({ action: 'getAssets' });
    const tpl = (assets.templates || []).find(t => t.domain === currentDomain);
    if (tpl) {
      document.getElementById('template-banner-text').textContent =
        `⭐ 该站点已保存模板（已用 ${tpl.usageCount || 0} 次），生成时优先使用`;
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  } catch (e) {
    banner.style.display = 'none';
  }
}

// Save the current editor values as the site template
async function saveTemplate() {
  if (!currentDomain || Object.keys(values).length === 0) return;
  try {
    await sendRuntimeMessage({
      action: 'saveTemplate',
      domain: currentDomain,
      data: values,
      fields: allFields
    });
    document.getElementById('save-template-btn').style.display = 'none';
    showStatus('⭐ 已存为本站模板，下次同站填充将优先复用', 'success');
  } catch (error) {
    showStatus('❌ 保存模板失败: ' + error.message, 'error');
  }
}

function hideLearnBanner() {
  document.getElementById('learn-banner').style.display = 'none';
}

// Persist user corrections as domain-scoped rules
async function saveLearnedRules() {
  if (pendingCorrections.length === 0) return;
  try {
    await sendRuntimeMessage({
      action: 'saveCorrectionRules',
      domain: currentDomain,
      corrections: pendingCorrections,
      fields: allFields
    });
    hideLearnBanner();
    showStatus('🎓 已记住偏好，下次该站点将自动应用修正值', 'success');
  } catch (error) {
    showStatus('❌ 保存偏好失败: ' + error.message, 'error');
  }
}

// ==================== P2: data assets management ====================

async function loadAssetsUI() {
  try {
    const assets = await sendRuntimeMessage({ action: 'getAssets' });
    renderPersonas(assets);
    renderTemplates(assets);
    renderRules(assets);
  } catch (error) {
    showStatus('❌ 加载数据资产失败: ' + error.message, 'error');
  }
}

function renderPersonas(assets) {
  const list = document.getElementById('persona-list');
  list.innerHTML = '';
  if (!assets.personas.length) {
    list.innerHTML = '<div class="asset-empty">暂无人设，点右上角创建</div>';
    return;
  }
  assets.personas.forEach(p => {
    const active = p.id === assets.activePersonaId;
    const f = p.fields || {};
    const item = document.createElement('div');
    item.className = 'asset-item' + (active ? ' active-item' : '');
    item.innerHTML = `
      <div class="item-main">
        <div class="item-title">${escapeHtml(p.name)}${active ? '<span class="badge">启用中</span>' : ''}${p.type === 'random' ? '<span class="badge">随机</span>' : ''}</div>
        <div class="item-sub">${escapeHtml([f.name, f.phone, f.email].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="item-actions">
        <button class="btn-mini ${active ? '' : 'primary'}" data-act="toggle">${active ? '停用' : '启用'}</button>
        <button class="btn-mini" data-act="del">删除</button>
      </div>`;
    item.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      await sendRuntimeMessage({ action: 'setActivePersona', id: active ? null : p.id });
      loadAssetsUI();
    });
    item.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await sendRuntimeMessage({ action: 'deletePersona', id: p.id });
      loadAssetsUI();
    });
    list.appendChild(item);
  });
}

function renderTemplates(assets) {
  const list = document.getElementById('template-list');
  list.innerHTML = '';
  if (!assets.templates.length) {
    list.innerHTML = '<div class="asset-empty">暂无模板，填充成功后可保存</div>';
    return;
  }
  assets.templates.forEach(t => {
    const item = document.createElement('div');
    item.className = 'asset-item';
    const date = t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '';
    item.innerHTML = `
      <div class="item-main">
        <div class="item-title">${escapeHtml(t.domain)}</div>
        <div class="item-sub">${Object.keys(t.data || {}).length} 个字段 · 已用 ${t.usageCount || 0} 次 · ${date}</div>
      </div>
      <div class="item-actions">
        <button class="btn-mini" data-act="del">删除</button>
      </div>`;
    item.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await sendRuntimeMessage({ action: 'deleteTemplate', id: t.id });
      loadAssetsUI();
      checkTemplateBanner();
    });
    list.appendChild(item);
  });
}

function renderRules(assets) {
  const list = document.getElementById('rule-list');
  list.innerHTML = '';
  if (!assets.rules.length) {
    list.innerHTML = '<div class="asset-empty">暂无规则</div>';
    return;
  }
  const typeLabel = { semantic: '语义', name: '字段名', label: '标签' };
  assets.rules.forEach(r => {
    const item = document.createElement('div');
    item.className = 'asset-item';
    item.innerHTML = `
      <div class="item-main">
        <div class="item-title">${escapeHtml(typeLabel[r.matchType] || r.matchType)}「${escapeHtml(r.matchValue)}」→ ${escapeHtml(r.value)}</div>
        <div class="item-sub">${r.scope === 'domain' ? '站点: ' + escapeHtml(r.domain || '') : '全局'}${r.learned ? '<span class="badge learned">学习所得</span>' : ''}</div>
      </div>
      <div class="item-actions">
        <button class="btn-mini" data-act="del">删除</button>
      </div>`;
    item.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await sendRuntimeMessage({ action: 'deleteRule', id: r.id });
      loadAssetsUI();
    });
    list.appendChild(item);
  });
}

async function addRandomPersona() {
  try {
    await sendRuntimeMessage({ action: 'createRandomPersona' });
    showStatus('🎭 已创建随机身份并启用', 'success');
    loadAssetsUI();
  } catch (error) {
    showStatus('❌ 创建失败: ' + error.message, 'error');
  }
}

function savePersonaForm() {
  const get = (id) => document.getElementById(id).value.trim();
  const fields = {};
  if (get('pf-realname')) fields.name = get('pf-realname');
  if (get('pf-phone')) fields.phone = get('pf-phone');
  if (get('pf-email')) fields.email = get('pf-email');
  if (get('pf-company')) fields.company = get('pf-company');
  if (get('pf-address')) fields.address = get('pf-address');
  if (get('pf-city')) fields.city = get('pf-city');
  if (get('pf-username')) fields.username = get('pf-username');
  if (Object.keys(fields).length === 0) {
    showStatus('⚠️ 请至少填写一项人设内容', 'error');
    return;
  }
  const persona = {
    id: localUid('persona'),
    name: get('pf-name') || ('真实档案 · ' + (fields.name || fields.username)),
    type: 'real',
    fields,
    createdAt: Date.now()
  };
  sendRuntimeMessage({ action: 'savePersona', persona }).then(() => {
    ['pf-name', 'pf-realname', 'pf-phone', 'pf-email', 'pf-company', 'pf-address', 'pf-city', 'pf-username']
      .forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('persona-form').style.display = 'none';
    showStatus('🎭 人设已保存并启用', 'success');
    loadAssetsUI();
  });
}

function addRule() {
  const matchType = document.getElementById('rf-match-type').value;
  const matchValue = matchType === 'semantic'
    ? document.getElementById('rf-semantic').value
    : document.getElementById('rf-match-value').value.trim();
  const value = document.getElementById('rf-value').value;
  const scope = document.getElementById('rf-scope').value;
  if (!matchValue || !value) {
    showStatus('⚠️ 请填写匹配值与固定填充值', 'error');
    return;
  }
  if (scope === 'domain' && !currentDomain) {
    showStatus('⚠️ 请先在填充页检测表单以获取当前站点', 'error');
    return;
  }
  const rule = {
    id: localUid('rule'),
    scope,
    domain: scope === 'domain' ? currentDomain : '',
    matchType,
    matchValue,
    value,
    enabled: true,
    createdAt: Date.now()
  };
  sendRuntimeMessage({ action: 'saveRule', rule }).then(() => {
    document.getElementById('rf-match-value').value = '';
    document.getElementById('rf-value').value = '';
    showStatus('🛠️ 规则已添加', 'success');
    loadAssetsUI();
  });
}

function localUid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function domainOfUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

// ==================== P3: batch fill ====================

// Show the batch button when the page has repeated rows
async function checkBatchRows() {
  const btn = document.getElementById('batch-btn');
  try {
    if (!currentTabId) { btn.style.display = 'none'; return; }
    const res = await sendTabMessage(currentTabId, { action: 'detectBatchRows' });
    const count = res && res.rows ? res.rows.length : 0;
    if (count >= 2) {
      btn.textContent = `🚀 批量填充 ${count} 行`;
      btn.style.display = 'block';
    } else {
      btn.style.display = 'none';
    }
  } catch (e) {
    btn.style.display = 'none';
  }
}

async function batchFill() {
  const btn = document.getElementById('batch-btn');
  btn.disabled = true;
  hideReport();
  showStatus('🚀 正在逐行生成并填充...', 'loading');
  try {
    const res = await sendRuntimeMessage({ action: 'batchFill', tabId: currentTabId });
    if (!res || !res.success) {
      showStatus('❌ ' + (res && res.error ? res.error : '批量填充失败'), 'error');
      return;
    }
    displayReport(res);
    showStatus(`🚀 批量填充完成：${res.rowCount} 行共 ${res.report.filledCount} 个字段`, 'success');
  } catch (error) {
    showStatus('❌ 批量填充失败: ' + error.message + '（请刷新页面后重试）', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ==================== P3: export / import / share code ====================

async function exportAssets() {
  try {
    const assets = await sendRuntimeMessage({ action: 'getAssets' });
    const payload = {
      app: 'FormPilot',
      kind: 'backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      personas: assets.personas,
      activePersonaId: assets.activePersonaId,
      templates: assets.templates,
      rules: assets.rules
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'formpilot-assets-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showStatus('⬇️ 已导出全量数据资产', 'success');
  } catch (error) {
    showStatus('❌ 导出失败: ' + error.message, 'error');
  }
}

async function importAssetsFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    await applyImport(payload);
  } catch (error) {
    showStatus('❌ 导入失败：文件不是有效的 JSON（' + error.message + '）', 'error');
  }
}

async function applyImport(payload) {
  if (!payload || typeof payload !== 'object' ||
      !(payload.templates || payload.personas || payload.rules)) {
    showStatus('❌ 导入失败：缺少模板/人设/规则数据', 'error');
    return;
  }
  const res = await sendRuntimeMessage({ action: 'importAssets', payload });
  if (res && res.success) {
    const c = res.counts;
    showStatus(`⬆️ 导入完成：模板 +${c.templates.added}/更新${c.templates.updated} · 人设 +${c.personas.added} · 规则 +${c.rules.added}`, 'success');
    loadAssetsUI();
    checkTemplateBanner();
  } else {
    showStatus('❌ 导入失败: ' + (res && res.error), 'error');
  }
}

// Share code = base64(JSON of templates+rules only, no persona privacy)
async function generateShareCode() {
  try {
    const assets = await sendRuntimeMessage({ action: 'getAssets' });
    const payload = {
      app: 'FormPilot',
      kind: 'share',
      version: 1,
      templates: assets.templates,
      rules: assets.rules
    };
    const code = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    const box = document.getElementById('share-box');
    box.style.display = 'block';
    box.value = code;
    document.getElementById('share-import-actions').style.display = 'none';
    try {
      await navigator.clipboard.writeText(code);
      showStatus('🔗 分享码已复制到剪贴板（仅含模板与规则）', 'success');
    } catch (e) {
      showStatus('🔗 分享码已生成，请手动复制', 'info');
    }
  } catch (error) {
    showStatus('❌ 生成分享码失败: ' + error.message, 'error');
  }
}

async function importShareCode() {
  const code = document.getElementById('share-box').value.trim();
  if (!code) {
    showStatus('⚠️ 请先粘贴分享码', 'error');
    return;
  }
  try {
    const payload = JSON.parse(decodeURIComponent(escape(atob(code))));
    await applyImport(payload);
    document.getElementById('share-box').style.display = 'none';
    document.getElementById('share-import-actions').style.display = 'none';
  } catch (error) {
    showStatus('❌ 分享码无效，请检查是否复制完整', 'error');
  }
}

// ==================== Utils ====================

function showStatus(message, type = 'info') {
  const statusElement = document.getElementById('status-message');
  statusElement.textContent = message;
  statusElement.className = `status-message show ${type}`;

  if (type === 'success' || type === 'error') {
    setTimeout(() => {
      statusElement.classList.remove('show');
    }, 8000);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

// Human-readable fallback name for unlabeled fields
const TYPE_FRIENDLY = {
  text: '文本输入', email: '邮箱', tel: '电话', number: '数字',
  date: '日期', time: '时间', password: '密码', url: '网址',
  checkbox: '勾选项', radio: '单选项', 'select-one': '下拉选择', select: '下拉选择'
};

function friendlyTypeName(field) {
  const t = String(field.type || '');
  if (t.startsWith('richtext')) return '富文本内容';
  if (t === 'custom-select') return '下拉选择';
  if (field.tagName === 'textarea') return '长文本内容';
  return TYPE_FRIENDLY[t] || '文本输入';
}

function cssEscape(text) {
  return window.CSS && CSS.escape ? CSS.escape(String(text)) : String(text).replace(/["\\]/g, '\\$&');
}
