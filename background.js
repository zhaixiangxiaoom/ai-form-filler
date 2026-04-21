// Background service worker for AI Form Filler extension

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
  console.log('AI Form Filler installed');
  
  // Set default configuration
  chrome.storage.sync.get(['config'], (result) => {
    if (!result.config) {
      chrome.storage.sync.set({ config: DEFAULT_CONFIG });
    }
  });
});

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
    handleGenerateFormData(message.fields, message.context)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep message channel open for async response
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

// Generate form data using AI
async function handleGenerateFormData(fields, context) {
  const config = await new Promise((resolve) => {
    chrome.storage.sync.get(['config'], (result) => {
      resolve(result.config || DEFAULT_CONFIG);
    });
  });
  
  if (!config.apiKey) {
    throw new Error('API key not configured. Please set your API key in the extension settings.');
  }
  
  // Build prompt for AI
  const prompt = buildAIPrompt(fields, context, config.language);
  
  try {
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
            content: '你是一个有用的助手，专门生成真实的表单数据。只返回有效的JSON格式，不要包含markdown格式或解释。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 1000
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'AI API request failed');
    }
    
    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    // Parse JSON response
    try {
      // Remove markdown code blocks if present
      const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      const formData = JSON.parse(jsonStr);
      return { success: true, data: formData };
    } catch (parseError) {
      console.error('Failed to parse AI response:', content);
      throw new Error('Failed to parse AI response as JSON');
    }
  } catch (error) {
    console.error('AI generation error:', error);
    throw error;
  }
}

// Build AI prompt based on form fields
function buildAIPrompt(fields, context, language) {
  const fieldDescriptions = fields.map(field => {
    const info = [
      `- "${field.name}" (type: ${field.type}`,
      field.label ? `label: "${field.label}"` : '',
      field.placeholder ? `placeholder: "${field.placeholder}"` : '',
      field.required ? 'required' : '',
      field.options ? `options: [${field.options.join(', ')}]` : ''
    ].filter(Boolean).join(', ') + ')';
    return info;
  }).join('\n');
  
  const contextInfo = context ? `\nPage context: ${context}` : '';
  const languageInfo = language === 'zh' ? 'Please generate data in Chinese.' : 'Please generate data in English.';
  
  return `Generate realistic data for the following form fields:${contextInfo}

Fields:
${fieldDescriptions}

Requirements:
1. Return a JSON object where keys are field names and values are the generated data
2. Make data realistic and appropriate for each field type
3. For email fields, generate valid email addresses
4. For phone fields, generate valid phone numbers
5. For select/radio fields, choose from the provided options
6. ${languageInfo}
7. Do NOT include any explanation, just return the JSON object

Example format:
{
  "username": "john_doe",
  "email": "john@example.com",
  "phone": "+1-555-0123"
}`;
}
