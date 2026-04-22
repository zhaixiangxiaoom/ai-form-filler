// Content script for form detection and auto-fill

let detectedForms = [];
let isProcessing = false;

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fillForm') {
    fillFormFields(message.formData);
  }
  
  if (message.action === 'detectForms') {
    const forms = detectAllForms();
    sendResponse({ forms: forms });
  }
});

// Detect all forms on the page
function detectAllForms() {
  detectedForms = [];
  const formElements = document.querySelectorAll('form');
  
  formElements.forEach((form, formIndex) => {
    const formInfo = {
      id: form.id || `form_${formIndex}`,
      action: form.action || '',
      method: form.method || '',
      fields: [],
      context: getPageContext()
    };
    
    // Get all form fields
    const fields = form.querySelectorAll('input, select, textarea');
    fields.forEach((field, fieldIndex) => {
      if (shouldSkipField(field)) return;
      
      const fieldInfo = extractFieldInfo(field, fieldIndex);
      formInfo.fields.push(fieldInfo);
    });
    
    // Detect rich text editors in this form
    const richTextEditors = detectRichTextEditors(form);
    richTextEditors.forEach((editor, editorIndex) => {
      formInfo.fields.push(editor);
    });
    
    detectedForms.push(formInfo);
  });
  
  // Also detect standalone fields outside forms
  const standaloneFields = document.querySelectorAll('input:not(form input), select:not(form select), textarea:not(form textarea)');
  if (standaloneFields.length > 0) {
    const standaloneForm = {
      id: 'standalone_fields',
      action: '',
      method: '',
      fields: [],
      context: getPageContext()
    };
    
    standaloneFields.forEach((field, fieldIndex) => {
      if (shouldSkipField(field)) return;
      const fieldInfo = extractFieldInfo(field, fieldIndex);
      standaloneForm.fields.push(fieldInfo);
    });
    
    // Detect standalone rich text editors
    const standaloneEditors = detectRichTextEditors(document.body);
    standaloneEditors.forEach(editor => {
      standaloneForm.fields.push(editor);
    });
    
    if (standaloneForm.fields.length > 0) {
      detectedForms.push(standaloneForm);
    }
  }
  
  return detectedForms;
}

// Extract information from a form field
function extractFieldInfo(field, index) {
  const fieldName = field.name || field.id || field.getAttribute('data-slot') || `field_${index}`;
  
  const fieldInfo = {
    name: fieldName,
    type: field.type || field.tagName.toLowerCase(),
    tagName: field.tagName.toLowerCase(),
    label: getFieldLabel(field),
    placeholder: field.placeholder || '',
    required: field.required || false,
    value: field.value || '',
    id: field.id || '',
    className: field.className || '',
    dataSlot: field.getAttribute('data-slot') || '',
    // Store unique selector for reliable filling
    selector: generateFieldSelector(field, index)
  };
  
  // Get options for select elements
  if (field.tagName.toLowerCase() === 'select') {
    fieldInfo.options = Array.from(field.options).map(opt => ({
      value: opt.value,
      text: opt.text
    }));
  }
  
  // Get options for radio/checkbox groups
  if (field.type === 'radio' || field.type === 'checkbox') {
    fieldInfo.options = [field.value || 'on'];
    fieldInfo.checked = field.checked;
  }
  
  return fieldInfo;
}

// Generate unique selector for field
function generateFieldSelector(field, index) {
  // Try to create a unique CSS selector
  if (field.id) {
    return `#${field.id}`;
  }
  
  if (field.name) {
    return `[name="${field.name}"]`;
  }
  
  if (field.getAttribute('data-slot')) {
    return `[data-slot="${field.getAttribute('data-slot')}"]`;
  }
  
  // Use tag name + placeholder + index as fallback
  const tagName = field.tagName.toLowerCase();
  const placeholder = field.placeholder ? `[placeholder="${field.placeholder}"]` : '';
  return `${tagName}${placeholder}:nth-of-type(${index + 1})`;
}

// Get label text for a field
function getFieldLabel(field) {
  // Try to find associated label
  if (field.id) {
    const label = document.querySelector(`label[for="${field.id}"]`);
    if (label) return label.textContent.trim();
  }
  
  // Try to find parent label
  const parentLabel = field.closest('label');
  if (parentLabel) {
    return parentLabel.textContent.trim();
  }
  
  // Try aria-label
  if (field.getAttribute('aria-label')) {
    return field.getAttribute('aria-label');
  }
  
  // Try to find preceding text
  const prevElement = field.previousElementSibling;
  if (prevElement && (prevElement.tagName.toLowerCase() === 'label' || prevElement.classList.contains('label'))) {
    return prevElement.textContent.trim();
  }
  
  return '';
}

// Detect rich text editors (TinyMCE, CKEditor, Quill, etc.)
function detectRichTextEditors(container) {
  const editors = [];
  
  // Method 1: Detect by common rich text editor classes/attributes
  const editorSelectors = [
    '[contenteditable="true"]',
    '.tinymce',
    '.ck-editor',
    '.ck-content',
    '.ql-editor',
    '.fr-element',
    '.note-editable',
    '[data-editor]',
    '.rich-text-editor',
    '.wysiwyg-editor',
    '.public-DraftEditor-content'  // Draft.js
  ];
  
  editorSelectors.forEach(selector => {
    try {
      const elements = container.querySelectorAll(selector);
      elements.forEach((element, index) => {
        const editorInfo = extractRichTextEditorInfo(element, index);
        if (editorInfo) {
          editors.push(editorInfo);
        }
      });
    } catch (e) {
      // Skip invalid selectors
    }
  });
  
  // Method 2: Detect iframes used by editors (TinyMCE, CKEditor)
  const iframes = container.querySelectorAll('iframe');
  iframes.forEach((iframe, index) => {
    const editorInfo = detectIframeEditor(iframe, index);
    if (editorInfo) {
      editors.push(editorInfo);
    }
  });
  
  // Method 3: Check for editor instances in window object
  if (container === document.body) {
    // TinyMCE
    if (window.tinymce || window.tinyMCE) {
      try {
        const editors_list = window.tinymce ? window.tinymce.editors : window.tinyMCE.editors;
        if (editors_list && editors_list.length > 0) {
          editors_list.forEach((editor, index) => {
            if (editor && editor.id) {
              editors.push({
                name: editor.id,
                type: 'richtext-tinymce',
                tagName: 'div',
                label: getLabelForElement(editor.id),
                placeholder: '',
                required: false,
                value: editor.getContent ? editor.getContent() : '',
                id: editor.id,
                className: 'tinymce-editor',
                editorType: 'tinymce'
              });
            }
          });
        }
      } catch (e) {
        console.log('TinyMCE detection error:', e);
      }
    }
    
    // CKEditor
    if (window.CKEDITOR) {
      try {
        const instances = window.CKEDITOR.instances;
        if (instances) {
          Object.keys(instances).forEach(name => {
            const editor = instances[name];
            if (editor) {
              editors.push({
                name: name,
                type: 'richtext-ckeditor',
                tagName: 'div',
                label: getLabelForElement(name),
                placeholder: '',
                required: false,
                value: editor.getData ? editor.getData() : '',
                id: name,
                className: 'ckeditor-editor',
                editorType: 'ckeditor'
              });
            }
          });
        }
      } catch (e) {
        console.log('CKEditor detection error:', e);
      }
    }
    
    // Quill
    if (window.Quill) {
      try {
        const quillEditors = document.querySelectorAll('.ql-container');
        quillEditors.forEach((container, index) => {
          const quill = container.__quill;
          if (quill) {
            const editorName = container.id || container.closest('[name]')?.name || `quill_${index}`;
            editors.push({
              name: editorName,
              type: 'richtext-quill',
              tagName: 'div',
              label: getLabelForElement(editorName),
              placeholder: '',
              required: false,
              value: quill.root.innerHTML || '',
              id: container.id || '',
              className: 'quill-editor',
              editorType: 'quill'
            });
          }
        });
      } catch (e) {
        console.log('Quill detection error:', e);
      }
    }
  }
  
  // Remove duplicates based on name/id
  const unique = [];
  const seen = new Set();
  editors.forEach(editor => {
    const key = editor.name || editor.id;
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(editor);
    }
  });
  
  return unique;
}

// Extract info from a rich text editor element
function extractRichTextEditorInfo(element, index) {
  if (!element) return null;
  
  const name = element.id || element.getAttribute('name') || element.name || `richtext_${index}`;
  const label = getLabelForElement(name);
  
  // Get current content
  let value = '';
  if (element.isContentEditable) {
    value = element.innerHTML || element.textContent || '';
  }
  
  return {
    name: name,
    type: 'richtext',
    tagName: element.tagName.toLowerCase(),
    label: label,
    placeholder: element.getAttribute('placeholder') || '',
    required: element.getAttribute('required') === 'true' || element.required || false,
    value: value,
    id: element.id || '',
    className: element.className || '',
    isContentEditable: element.isContentEditable || false,
    editorType: detectEditorType(element)
  };
}

// Detect editor type from element
function detectEditorType(element) {
  const className = (element.className || '').toLowerCase();
  
  if (className.includes('tinymce') || className.includes('mce')) return 'tinymce';
  if (className.includes('ck-editor') || className.includes('ckeditor')) return 'ckeditor';
  if (className.includes('ql-editor') || className.includes('quill')) return 'quill';
  if (className.includes('fr-element') || className.includes('froala')) return 'froala';
  if (className.includes('note-editable') || className.includes('summernote')) return 'summernote';
  if (className.includes('public-drafteditor-content') || className.includes('draft-js')) return 'draftjs';
  
  return 'unknown';
}

// Detect iframe-based editors
function detectIframeEditor(iframe, index) {
  try {
    // Check if iframe has contenteditable body
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    if (iframeDoc && iframeDoc.body && iframeDoc.body.getAttribute('contenteditable') === 'true') {
      const name = iframe.id || iframe.name || iframe.getAttribute('aria-label') || `iframe_editor_${index}`;
      return {
        name: name,
        type: 'richtext-iframe',
        tagName: 'iframe',
        label: getLabelForElement(name),
        placeholder: '',
        required: false,
        value: iframeDoc.body.innerHTML || '',
        id: iframe.id || '',
        className: iframe.className || '',
        editorType: 'iframe'
      };
    }
  } catch (e) {
    // Cross-origin iframe, skip
  }
  return null;
}

// Get label for an element
function getLabelForElement(elementId) {
  if (!elementId) return '';
  
  // Try to find associated label
  const label = document.querySelector(`label[for="${elementId}"]`);
  if (label) return label.textContent.trim();
  
  // Try to find parent label
  const element = document.getElementById(elementId);
  if (element) {
    const parentLabel = element.closest('label');
    if (parentLabel) return parentLabel.textContent.trim();
  }
  
  return '';
}

// Check if field should be skipped
function shouldSkipField(field) {
  const skipTypes = ['hidden', 'submit', 'button', 'reset', 'image'];
  
  if (skipTypes.includes(field.type)) return true;
  if (field.disabled) return true;
  if (field.readOnly) return true;
  if (field.getAttribute('autocomplete') === 'off') return false; // Still try to fill
  
  // Skip if field is not visible
  const rect = field.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return true;
  
  return false;
}

// Get page context for better AI generation
function getPageContext() {
  const title = document.title || '';
  const url = window.location.href;
  const metaDescription = document.querySelector('meta[name="description"]')?.content || '';
  
  return {
    title,
    url,
    metaDescription
  };
}

// Fill form fields with generated data
function fillFormFields(formData) {
  console.log('[AI Form Filler] Starting to fill fields:', formData);
  console.log('[AI Form Filler] Total fields to fill:', Object.keys(formData).length);
  
  isProcessing = true;
  let filledCount = 0;
  
  Object.keys(formData).forEach(fieldName => {
    const value = formData[fieldName];
    console.log(`[AI Form Filler] Processing field: ${fieldName}`, 'Type:', typeof value, 'Value preview:', String(value).substring(0, 100));
    
    // First try to find by name/id
    const fields = findFieldsByName(fieldName);
    console.log(`[AI Form Filler] Found ${fields.length} elements for field: ${fieldName}`);
    
    if (fields.length > 0) {
      fields.forEach(field => {
        console.log(`[AI Form Filler] Attempting to fill element:`, field.tagName, field.type || '', field.name || field.id || '');
        if (fillField(field, value)) {
          filledCount++;
          console.log(`[AI Form Filler] ✅ Successfully filled: ${fieldName}`);
        } else {
          console.log(`[AI Form Filler] ❌ Failed to fill: ${fieldName}`);
        }
      });
    } else {
      // If not found by name, try to match by label or placeholder
      console.log(`[AI Form Filler] No elements found by name, trying label/placeholder match for: ${fieldName}`);
      const matchedField = findFieldByLabelOrPlaceholder(fieldName, value);
      if (matchedField) {
        console.log(`[AI Form Filler] Found matching field by label/placeholder:`, matchedField.tagName, matchedField.name || matchedField.id || '');
        if (fillField(matchedField, value)) {
          filledCount++;
          console.log(`[AI Form Filler] ✅ Successfully filled via label/placeholder: ${fieldName}`);
        }
      } else {
        console.log(`[AI Form Filler] ❌ Could not find any matching field for: ${fieldName}`);
      }
    }
  });
  
  // Dispatch events to trigger any listeners
  dispatchFormEvents();
  
  console.log(`[AI Form Filler] Completed! Successfully filled ${filledCount} fields`);
  isProcessing = false;
  
  // Show notification
  showNotification(`Successfully filled ${filledCount} fields!`, 'success');
}

// Find fields by name, id, or other attributes
function findFieldsByName(name) {
  const fields = [];
  
  // Search by name attribute
  const byName = document.querySelectorAll(`[name="${name}"]`);
  byName.forEach(f => fields.push(f));
  
  // Search by id
  const byId = document.querySelectorAll(`#${name}`);
  byId.forEach(f => {
    if (!fields.includes(f)) fields.push(f);
  });
  
  // Search by data-slot attribute (for modern frameworks)
  if (fields.length === 0) {
    const byDataSlot = document.querySelectorAll(`[data-slot="${name}"]`);
    byDataSlot.forEach(f => {
      if (!fields.includes(f)) fields.push(f);
    });
  }
  
  // Search by placeholder text (fallback)
  if (fields.length === 0) {
    const allTextareas = document.querySelectorAll('textarea');
    allTextareas.forEach(f => {
      if (!fields.includes(f) && f.placeholder && 
          (f.placeholder.includes(name) || name.includes(f.placeholder))) {
        fields.push(f);
      }
    });
  }
  
  return fields;
}

// Find field by label text or placeholder when name doesn't match
function findFieldByLabelOrPlaceholder(fieldName, value) {
  // Try to find textarea/input with matching placeholder
  const allFields = document.querySelectorAll('textarea, input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
  
  for (let field of allFields) {
    // Check placeholder match
    if (field.placeholder && field.placeholder.includes(fieldName)) {
      return field;
    }
    
    // Check label match
    const label = getFieldLabel(field);
    if (label && label.includes(fieldName)) {
      return field;
    }
    
    // Check data-slot match
    const dataSlot = field.getAttribute('data-slot');
    if (dataSlot && dataSlot.includes(fieldName)) {
      return field;
    }
  }
  
  return null;
}

// Fill a single field with value
function fillField(field, value) {
  if (!value && value !== '') return false;
  
  try {
    const tagName = field.tagName.toLowerCase();
    const type = field.type;
    
    // Handle rich text editors
    if (type && type.startsWith('richtext')) {
      return fillRichTextField(field, value);
    }
    
    // Handle different field types
    if (tagName === 'select') {
      return fillSelectField(field, value);
    }
    
    if (type === 'radio') {
      return fillRadioField(field, value);
    }
    
    if (type === 'checkbox') {
      return fillCheckboxField(field, value);
    }
    
    // Default: text, email, phone, textarea, etc.
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    
    return true;
  } catch (error) {
    console.error('Error filling field:', field.name, error);
    return false;
  }
}

// Fill rich text editor field
function fillRichTextField(field, value) {
  try {
    const editorType = field.editorType || detectEditorTypeByName(field.name);
    
    // TinyMCE
    if (editorType === 'tinymce' && window.tinymce) {
      const editor = window.tinymce.get(field.name || field.id);
      if (editor) {
        editor.setContent(value);
        editor.save();
        console.log('Filled TinyMCE editor:', field.name);
        return true;
      }
    }
    
    // CKEditor
    if (editorType === 'ckeditor' && window.CKEDITOR) {
      const editor = window.CKEDITOR.instances[field.name || field.id];
      if (editor) {
        editor.setData(value);
        console.log('Filled CKEditor:', field.name);
        return true;
      }
    }
    
    // Quill
    if (editorType === 'quill') {
      // Try multiple strategies to find Quill
      let quill = null;
      
      // Strategy 1: Find by ID
      if (field.id) {
        const el = document.getElementById(field.id);
        quill = el?.__quill || el?.querySelector('.ql-container')?.__quill;
      }
      
      // Strategy 2: Find any Quill instance on page
      if (!quill) {
        const allQuillContainers = document.querySelectorAll('.ql-container');
        for (const container of allQuillContainers) {
          if (container.__quill) {
            quill = container.__quill;
            break;
          }
        }
      }
      
      if (quill) {
        quill.clipboard.dangerouslyPasteHTML(value);
        console.log('Filled Quill editor:', field.name);
        return true;
      }
    }
    
    // Froala
    if (editorType === 'froala' && window.FroalaEditor) {
      const element = document.getElementById(field.name || field.id);
      if (element && element.froalaEditor) {
        element.froalaEditor('html.set', value);
        console.log('Filled Froala editor:', field.name);
        return true;
      }
    }
    
    // Summernote
    if (editorType === 'summernote' && window.jQuery) {
      const element = document.getElementById(field.name || field.id);
      if (element && window.jQuery(element).summernote) {
        window.jQuery(element).summernote('code', value);
        console.log('Filled Summernote editor:', field.name);
        return true;
      }
    }
    
    // Draft.js
    if (editorType === 'draftjs') {
      // Draft.js uses contenteditable div with specific structure
      const element = document.getElementById(field.id) || 
                      document.querySelector(`[data-editor="${field.id}"]`) ||
                      document.querySelector('.public-DraftEditor-content');
      
      if (element) {
        // For Draft.js, we need to simulate user input
        // Clear existing content
        element.innerHTML = '';
        
        // Create Draft.js compatible structure
        const dataBlock = document.createElement('div');
        dataBlock.setAttribute('data-contents', 'true');
        
        const innerDiv = document.createElement('div');
        innerDiv.className = '';
        innerDiv.setAttribute('data-block', 'true');
        innerDiv.setAttribute('data-editor', element.getAttribute('data-editor') || '');
        innerDiv.setAttribute('data-offset-key', '0-0-0');
        
        const contentDiv = document.createElement('div');
        contentDiv.setAttribute('data-offset-key', '0-0-0');
        contentDiv.className = 'public-DraftStyleDefault-block public-DraftStyleDefault-ltr';
        
        const span = document.createElement('span');
        span.setAttribute('data-offset-key', '0-0-0');
        span.textContent = value;
        
        contentDiv.appendChild(span);
        innerDiv.appendChild(contentDiv);
        dataBlock.appendChild(innerDiv);
        element.appendChild(dataBlock);
        
        // Trigger events
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        
        console.log('Filled Draft.js editor:', field.name);
        return true;
      }
    }
    
    // Generic contenteditable
    if (field.isContentEditable || field.tagName.toLowerCase() === 'div' || field.tagName.toLowerCase() === 'iframe') {
      let element = null;
      
      if (field.tagName.toLowerCase() === 'iframe') {
        // Handle iframe-based editors
        try {
          const iframe = document.getElementById(field.id);
          if (iframe) {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
            if (iframeDoc && iframeDoc.body) {
              iframeDoc.body.innerHTML = value;
              console.log('Filled iframe editor:', field.name);
              return true;
            }
          }
        } catch (e) {
          console.log('Cannot access iframe content:', e);
        }
      } else {
        // Contenteditable div
        element = document.getElementById(field.id) || document.querySelector(`[name="${field.name}"]`);
        if (!element) {
          element = document.querySelector(`#${field.name}`);
        }
        
        if (element) {
          element.innerHTML = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('Filled contenteditable:', field.name);
          return true;
        }
      }
    }
    
    // Fallback: try to find textarea/input with same name
    const textarea = document.querySelector(`textarea[name="${field.name}"]`);
    if (textarea) {
      textarea.value = value;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('Filled textarea fallback:', field.name);
      return true;
    }
    
    console.log('Could not fill rich text editor:', field.name, editorType);
    return false;
  } catch (error) {
    console.error('Error filling rich text field:', field.name, error);
    return false;
  }
}

// Detect editor type by name/id
function detectEditorTypeByName(name) {
  if (!name) return 'unknown';
  
  // Search for editor instances
  if (window.tinymce && window.tinymce.get(name)) return 'tinymce';
  if (window.CKEDITOR && window.CKEDITOR.instances[name]) return 'ckeditor';
  
  // Check DOM for editor classes
  const element = document.getElementById(name) || document.querySelector(`[name="${name}"]`);
  if (element) {
    return detectEditorType(element);
  }
  
  return 'unknown';
}

// Fill select field
function fillSelectField(field, value) {
  const options = Array.from(field.options);
  
  // Try to match by value
  const optionByValue = options.find(opt => opt.value === value);
  if (optionByValue) {
    field.value = value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  
  // Try to match by text
  const optionByText = options.find(opt => opt.text.toLowerCase().includes(value.toLowerCase()));
  if (optionByText) {
    field.value = optionByText.value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  
  return false;
}

// Fill radio field
function fillRadioField(field, value) {
  if (field.value === value || field.value.toLowerCase().includes(value.toLowerCase())) {
    field.checked = true;
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

// Fill checkbox field
function fillCheckboxField(field, value) {
  // Handle boolean values
  if (typeof value === 'boolean') {
    field.checked = value;
  } else if (typeof value === 'string') {
    field.checked = value.toLowerCase() === 'true' || value === '1' || value === 'yes';
  }
  field.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// Dispatch events to trigger validation and other listeners
function dispatchFormEvents() {
  const forms = document.querySelectorAll('form');
  forms.forEach(form => {
    form.dispatchEvent(new Event('change', { bubbles: true }));
    form.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// Show notification to user
function showNotification(message, type = 'info') {
  // Create notification element
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 15px 20px;
    background: ${type === 'success' ? '#4CAF50' : '#2196F3'};
    color: white;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    z-index: 10000;
    font-family: Arial, sans-serif;
    font-size: 14px;
    max-width: 300px;
    animation: slideIn 0.3s ease;
  `;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  // Auto remove after 3 seconds
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(400px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(400px); opacity: 0; }
  }
`;
document.head.appendChild(style);

// Auto-detect forms on page load
setTimeout(() => {
  const forms = detectAllForms();
  if (forms.length > 0) {
    console.log(`AI Form Filler: Detected ${forms.length} form(s) on page`);
  }
}, 1000);
