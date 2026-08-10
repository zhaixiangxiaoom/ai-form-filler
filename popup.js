// Popup script for FormPilot extension

let detectedForms = [];
let currentConfig = {};
let lastTabId = null;

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

// Promise wrapper for runtime messaging
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

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  setupTabs();
  setupEventListeners();
});

// Load configuration from storage
async function loadConfig() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getConfig' }, (config) => {
      currentConfig = config;
      populateSettingsForm(config);
      resolve(config);
    });
  });
}

// Populate settings form with current config
function populateSettingsForm(config) {
  document.getElementById('api-key').value = config.apiKey || '';
  document.getElementById('api-url').value = config.apiUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  document.getElementById('model').value = config.model || 'qwen-plus';
  document.getElementById('language').value = config.language || 'zh';
  document.getElementById('auto-fill').checked = config.autoFill || false;
}

// Setup tab switching
function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;
      
      // Update active tab button
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // Update active tab content
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
      });
      document.getElementById(`${tabName}-tab`).classList.add('active');
    });
  });
}

// Setup event listeners
function setupEventListeners() {
  // One-click smart fill
  document.getElementById('smart-btn').addEventListener('click', smartFill);
  
  // Preview-only detection
  document.getElementById('detect-btn').addEventListener('click', detectForms);
  
  // Undo last fill
  document.getElementById('undo-btn').addEventListener('click', undoFill);
  
  // Settings form
  document.getElementById('settings-form').addEventListener('submit', saveSettings);
}

// Detect forms on current page (preview only)
async function detectForms() {
  showStatus('Detecting forms on page...', 'loading');
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    lastTabId = tab.id;
    
    const response = await sendTabMessage(tab.id, { action: 'detectForms' });
    
    if (response && response.forms) {
      detectedForms = response.forms;
      displayFormInfo(response.forms);
      
      if (response.forms.length > 0) {
        const totalFields = response.forms.reduce((sum, form) => sum + form.fields.length, 0);
        showStatus(`✅ Detected ${response.forms.length} form(s) with ${totalFields} fields`, 'success');
      } else {
        showStatus('No forms detected on this page', 'info');
      }
    }
  } catch (error) {
    showStatus('Error: Could not connect to page. Please refresh and try again.', 'error');
  }
}

// Display form information
function displayFormInfo(forms) {
  const totalFields = forms.reduce((sum, form) => sum + form.fields.length, 0);
  
  document.getElementById('forms-count').textContent = forms.length;
  document.getElementById('fields-count').textContent = totalFields;
  
  // Display field preview
  const previewSection = document.getElementById('preview-section');
  const fieldsPreview = document.getElementById('fields-preview');
  
  if (totalFields > 0) {
    previewSection.style.display = 'block';
    fieldsPreview.innerHTML = '';
    
    forms.forEach((form, formIndex) => {
      if (form.fields.length === 0) return;
      
      const formTitle = document.createElement('div');
      formTitle.style.cssText = 'font-weight: 600; color: #333; margin: 15px 0 10px 0; padding: 8px; background: #e3f2fd; border-radius: 4px;';
      formTitle.textContent = form.id !== 'standalone_fields' ? `Form: ${form.id}` : 'Standalone Fields';
      fieldsPreview.appendChild(formTitle);
      
      form.fields.forEach(field => {
        const fieldItem = document.createElement('div');
        fieldItem.className = 'field-item';
        
        fieldItem.innerHTML = `
          <div class="field-name">${field.label || field.name}</div>
          <div class="field-details">
            <span>Type: ${field.type}</span>
            <span>Name: ${field.name}</span>
            ${field.required ? '<span>Required</span>' : ''}
            ${field.placeholder ? `<span>Placeholder: ${field.placeholder}</span>` : ''}
          </div>
        `;
        
        fieldsPreview.appendChild(fieldItem);
      });
    });
  } else {
    previewSection.style.display = 'none';
  }
}

// One-click smart fill: detect -> hybrid generate -> fill -> report
async function smartFill() {
  const smartBtn = document.getElementById('smart-btn');
  smartBtn.disabled = true;
  hideReport();
  
  try {
    // Step 1: Detect forms
    showStatus('🔍 Detecting forms on page...', 'loading');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    lastTabId = tab.id;
    
    const detectResponse = await sendTabMessage(tab.id, { action: 'detectForms' });
    if (!detectResponse || !detectResponse.forms || detectResponse.forms.length === 0) {
      showStatus('No forms detected on this page', 'info');
      return;
    }
    
    detectedForms = detectResponse.forms;
    displayFormInfo(detectedForms);
    
    // Step 2: Hybrid generation (rule engine + AI)
    showStatus('🧠 Generating fill content (rules + AI)...', 'loading');
    const allFields = [];
    detectedForms.forEach(form => allFields.push(...form.fields));
    const context = detectedForms[0]?.context || null;
    
    const gen = await sendRuntimeMessage({
      action: 'generateFormData',
      fields: allFields,
      context: context
    });
    
    if (gen.error) {
      showStatus('❌ ' + gen.error, 'error');
      return;
    }
    
    const data = gen.data || {};
    if (Object.keys(data).length === 0) {
      showStatus('❌ No fill content could be generated. Please configure your API key in Settings.', 'error');
      return;
    }
    
    // Step 3: Fill and get validation report
    showStatus('✍️ Filling form...', 'loading');
    const report = await sendTabMessage(tab.id, {
      action: 'fillForm',
      formData: data
    });
    
    // Step 4: Show report
    displayReport(gen, report || {});
  } catch (error) {
    showStatus('❌ Error: ' + error.message + '. Try refreshing the page.', 'error');
  } finally {
    smartBtn.disabled = false;
  }
}

// Render the fill report with stats and validation issues
function displayReport(gen, report) {
  const section = document.getElementById('report-section');
  const content = document.getElementById('report-content');
  const stats = gen.stats || {};
  const invalidFields = report.invalidFields || [];
  const notFound = report.notFound || [];
  const skipped = stats.skippedFields || [];
  
  let html = `
    <div class="report-summary ${invalidFields.length === 0 ? 'ok' : 'warn'}">
      ✅ Filled ${report.filledCount ?? 0} fields
      (🧩 rules: ${stats.ruleCount ?? 0} · 🤖 AI: ${stats.aiCount ?? 0})
    </div>
  `;
  
  if (invalidFields.length > 0) {
    html += `<div class="report-group-title">⚠️ ${invalidFields.length} field(s) failed page validation:</div>`;
    invalidFields.forEach(f => {
      html += `
        <div class="report-item invalid">
          <div class="report-field-name">${escapeHtml(f.label || f.name)}</div>
          <div class="report-field-msg">${escapeHtml(f.message)}</div>
        </div>
      `;
    });
  }
  
  if (notFound.length > 0) {
    html += `<div class="report-group-title">🔍 ${notFound.length} field(s) not matched on page:</div>`;
    html += `<div class="report-item muted">${escapeHtml(notFound.join(', '))}</div>`;
  }
  
  if (skipped.length > 0) {
    html += `<div class="report-group-title">⏭️ ${skipped.length} open-ended field(s) skipped:</div>`;
    html += `<div class="report-item muted">${escapeHtml(skipped.join(', '))}<br>` +
      `${gen.aiError ? escapeHtml(gen.aiError) : 'AI did not return these fields.'}</div>`;
  }
  
  content.innerHTML = html;
  section.style.display = 'block';
  
  // Undo button
  const undoBtn = document.getElementById('undo-btn');
  undoBtn.style.display = report.canUndo ? 'flex' : 'none';
  
  if (invalidFields.length > 0) {
    showStatus(`⚠️ Filled ${report.filledCount} fields, ${invalidFields.length} failed validation`, 'error');
  } else {
    showStatus(`✅ Form filled successfully! (${report.filledCount} fields)`, 'success');
  }
}

// Hide report section
function hideReport() {
  document.getElementById('report-section').style.display = 'none';
  document.getElementById('undo-btn').style.display = 'none';
}

// Undo the last fill via snapshot restore
async function undoFill() {
  if (!lastTabId) return;
  try {
    const response = await sendTabMessage(lastTabId, { action: 'undoFill' });
    if (response && response.success) {
      showStatus(`↩️ Restored ${response.restoredCount} fields to previous values`, 'success');
      hideReport();
    } else {
      showStatus(response?.error || 'Nothing to undo', 'info');
    }
  } catch (error) {
    showStatus('Undo failed: ' + error.message, 'error');
  }
}

// Escape HTML for safe rendering
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

// Save settings
async function saveSettings(event) {
  event.preventDefault();
  
  const config = {
    apiKey: document.getElementById('api-key').value.trim(),
    apiUrl: document.getElementById('api-url').value.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: document.getElementById('model').value,
    language: document.getElementById('language').value,
    autoFill: document.getElementById('auto-fill').checked
  };
  
  if (!config.apiKey) {
    showStatus('API key is required', 'error');
    return;
  }
  
  try {
    chrome.runtime.sendMessage({ action: 'updateConfig', config: config }, (response) => {
      if (response.success) {
        currentConfig = config;
        showStatus('✅ Settings saved successfully!', 'success');
      } else {
        showStatus('Error saving settings', 'error');
      }
    });
  } catch (error) {
    showStatus('Error saving settings: ' + error.message, 'error');
  }
}

// Show status message
function showStatus(message, type = 'info') {
  const statusElement = document.getElementById('status-message');
  statusElement.textContent = message;
  statusElement.className = `status-message show ${type}`;
  
  // Auto hide after 5 seconds for success/error messages
  if (type === 'success' || type === 'error') {
    setTimeout(() => {
      statusElement.classList.remove('show');
    }, 5000);
  }
}
