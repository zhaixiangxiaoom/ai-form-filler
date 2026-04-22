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
  console.log('[AI Form Filler] Starting to fill fields:', Object.keys(formData).length, 'fields');
  
  isProcessing = true;
  let filledCount = 0;
  
  // Get all form fields on the page with their detection indices
  const allFields = getAllFieldsWithIndices();
  
  Object.keys(formData).forEach(fieldName => {
    const value = formData[fieldName];
    console.log(`[AI Form Filler] Processing: ${fieldName} (${typeof value})`);
    
    // Strategy 1: Try to find by exact name/id match
    let fields = findFieldsByName(fieldName);
    
    // Strategy 2: If not found, try to match by detection index
    if (fields.length === 0) {
      const indexMatch = fieldName.match(/^(\w+)_(\d+)$/);
      if (indexMatch) {
        const [, tagName, index] = indexMatch;
        console.log(`[AI Form Filler] Trying index-based match: ${tagName}[${index}]`);
        const matchedFieldObj = findFieldByTagAndIndex(tagName, parseInt(index), allFields);
        if (matchedFieldObj) {
          // Use the actual element from the field object
          fields = [matchedFieldObj.element];
          // Copy editorType and other metadata to the element
          if (matchedFieldObj.editorType) {
            fields[0].editorType = matchedFieldObj.editorType;
          }
          if (matchedFieldObj.type) {
            fields[0].type = matchedFieldObj.type;
          }
          if (matchedFieldObj.className) {
            fields[0].className = matchedFieldObj.className;
          }
        }
      }
    }
    
    // Strategy 3: Try placeholder/label match
    if (fields.length === 0) {
      console.log(`[AI Form Filler] Trying placeholder/label match for: ${fieldName}`);
      const matched = findFieldByLabelOrPlaceholder(fieldName, value);
      if (matched) fields = [matched];
    }
    
    // Fill the found field(s)
    if (fields.length > 0) {
      fields.forEach(field => {
        if (fillField(field, value)) {
          filledCount++;
          console.log(`[AI Form Filler] ✅ Filled: ${fieldName}`);
        }
      });
    } else {
      console.log(`[AI Form Filler] ❌ Not found: ${fieldName}`);
    }
  });
  
  dispatchFormEvents();
  console.log(`[AI Form Filler] Completed! Filled ${filledCount}/${Object.keys(formData).length} fields`);
  isProcessing = false;
  
  showNotification(`Successfully filled ${filledCount} fields!`, 'success');
}

// Get all form fields with their detection indices
function getAllFieldsWithIndices() {
  const fields = [];
  let index = 0;
  
  // Get standard form fields
  const standardFields = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea');
  standardFields.forEach(field => {
    if (!shouldSkipField(field)) {
      fields.push({
        element: field,
        tagName: field.tagName.toLowerCase(),
        type: field.type || field.tagName.toLowerCase(),
        index: index++,
        name: field.name || '',
        id: field.id || '',
        placeholder: field.placeholder || ''
      });
    }
  });
  
  // Get rich text editors
  const richtextSelectors = [
    '[contenteditable="true"]',
    '.ql-container',
    '.tinymce',
    '.ck-content',
    '.public-DraftEditor-content'
  ];
  
  richtextSelectors.forEach(selector => {
    try {
      document.querySelectorAll(selector).forEach(element => {
        const editorType = detectEditorType(element);
        
        // For Quill, verify we can find the instance
        if (editorType === 'quill') {
          const hasQuill = !!element.querySelector('.ql-editor') || 
                          element.classList.contains('ql-container');
          if (!hasQuill) {
            console.log('[Detection] Skipping non-Quill element:', element.className);
            return;
          }
          console.log('[Detection] Found Quill container:', element.id || 'no-id');
        }
        
        fields.push({
          element: element,
          tagName: element.tagName.toLowerCase(),
          type: 'richtext-' + editorType,
          index: index++,
          name: element.id || '',
          id: element.id || '',
          placeholder: element.getAttribute('placeholder') || '',
          editorType: editorType,
          className: element.className || ''
        });
      });
    } catch (e) {}
  });
  
  return fields;
}

// Find field by tag name and detection index
function findFieldByTagAndIndex(tagName, targetIndex, allFields) {
  console.log(`[Index Match] Looking for ${tagName}[${targetIndex}]`);
  console.log(`[Index Match] Total fields:`, allFields.length);
  
  // Filter fields by tag name or type prefix
  const matchingFields = allFields.filter(f => {
    // Match by tag name (e.g., 'div', 'input')
    const byTagName = f.tagName === tagName.toLowerCase();
    // Match by type prefix (e.g., 'richtext' matches 'richtext-quill')
    const byType = f.type && f.type.toLowerCase().startsWith(tagName.toLowerCase());
    const match = byTagName || byType;
    
    if (match) {
      console.log(`[Index Match] Found:`, f.tagName, 'type:', f.type, 'index:', f.index);
    }
    return match;
  });
  
  console.log(`[Index Match] Matches:`, matchingFields.length);
  
  // Return full field object (not just element)
  if (matchingFields.length > 0 && targetIndex < matchingFields.length) {
    console.log(`[Index Match] ✅ Returning field at index ${targetIndex}`);
    return matchingFields[targetIndex];
  }
  
  console.log(`[Index Match] ❌ Index out of range`);
  return null;
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

// Fill rich text editor field - Simplified approach
function fillRichTextField(field, value) {
  try {
    console.log('[RichText Fill] Filling:', field.tagName, field.className?.substring(0, 50));
    
    // Strategy 1: Direct innerHTML on contenteditable or div elements
    if (field.isContentEditable || field.tagName.toLowerCase() === 'div') {
      field.innerHTML = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[RichText Fill] ✅ Filled via innerHTML');
      return true;
    }
    
    // Strategy 2: For Quill - find .ql-editor inside
    const qlEditor = field.querySelector?.('.ql-editor');
    if (qlEditor) {
      qlEditor.innerHTML = value;
      qlEditor.dispatchEvent(new Event('input', { bubbles: true }));
      console.log('[RichText Fill] ✅ Filled Quill via .ql-editor');
      return true;
    }
    
    // Strategy 3: For iframe editors
    if (field.tagName.toLowerCase() === 'iframe') {
      const iframeDoc = field.contentDocument || field.contentWindow?.document;
      if (iframeDoc?.body) {
        iframeDoc.body.innerHTML = value;
        console.log('[RichText Fill] ✅ Filled iframe editor');
        return true;
      }
    }
    
    // Strategy 4: TinyMCE via API
    if (window.tinymce) {
      const editor = window.tinymce.get(field.id || field.name);
      if (editor) {
        editor.setContent(value);
        editor.save();
        console.log('[RichText Fill] ✅ Filled TinyMCE');
        return true;
      }
    }
    
    // Strategy 5: CKEditor via API
    if (window.CKEDITOR) {
      const editor = window.CKEDITOR.instances[field.id || field.name];
      if (editor) {
        editor.setData(value);
        console.log('[RichText Fill] ✅ Filled CKEditor');
        return true;
      }
    }
    
    console.error('[RichText Fill] ❌ Could not fill element');
    return false;
  } catch (error) {
    console.error('[RichText Fill] Error:', error);
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
