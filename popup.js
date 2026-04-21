// Popup script for AI Form Filler extension

let detectedForms = [];
let currentConfig = {};

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
  // Detect forms button
  document.getElementById('detect-btn').addEventListener('click', detectForms);
  
  // Fill button
  document.getElementById('fill-btn').addEventListener('click', generateAndFill);
  
  // Settings form
  document.getElementById('settings-form').addEventListener('submit', saveSettings);
}

// Detect forms on current page
async function detectForms() {
  showStatus('Detecting forms on page...', 'loading');
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    chrome.tabs.sendMessage(tab.id, { action: 'detectForms' }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus('Error: Could not connect to page. Please refresh and try again.', 'error');
        return;
      }
      
      if (response && response.forms) {
        detectedForms = response.forms;
        displayFormInfo(response.forms);
        
        if (response.forms.length > 0) {
          const totalFields = response.forms.reduce((sum, form) => sum + form.fields.length, 0);
          showStatus(`✅ Detected ${response.forms.length} form(s) with ${totalFields} fields`, 'success');
          document.getElementById('fill-btn').disabled = false;
        } else {
          showStatus('No forms detected on this page', 'info');
          document.getElementById('fill-btn').disabled = true;
        }
      }
    });
  } catch (error) {
    showStatus('Error detecting forms: ' + error.message, 'error');
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

// Generate AI data and fill form
async function generateAndFill() {
  if (detectedForms.length === 0) {
    showStatus('Please detect forms first', 'error');
    return;
  }
  
  if (!currentConfig.apiKey) {
    showStatus('Please configure your API key in Settings', 'error');
    // Switch to settings tab
    document.querySelector('[data-tab="settings"]').click();
    return;
  }
  
  showStatus('🤖 Generating form data with AI...', 'loading');
  document.getElementById('fill-btn').disabled = true;
  
  try {
    // Collect all fields from all forms
    const allFields = [];
    detectedForms.forEach(form => {
      allFields.push(...form.fields);
    });
    
    // Get page context from first form
    const context = detectedForms[0]?.context || null;
    
    // Send request to background script for AI generation
    chrome.runtime.sendMessage(
      {
        action: 'generateFormData',
        fields: allFields,
        context: context
      },
      (response) => {
        if (chrome.runtime.lastError) {
          showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
          document.getElementById('fill-btn').disabled = false;
          return;
        }
        
        if (response.error) {
          showStatus('❌ ' + response.error, 'error');
          document.getElementById('fill-btn').disabled = false;
          return;
        }
        
        if (response.success && response.data) {
          showStatus('✨ Filling form with AI-generated data...', 'loading');
          
          // Send fill command to content script
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
              chrome.tabs.sendMessage(tabs[0].id, {
                action: 'fillForm',
                formData: response.data
              });
              
              showStatus('✅ Form filled successfully!', 'success');
              document.getElementById('fill-btn').disabled = false;
            }
          });
        }
      }
    );
  } catch (error) {
    showStatus('❌ Error: ' + error.message, 'error');
    document.getElementById('fill-btn').disabled = false;
  }
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
