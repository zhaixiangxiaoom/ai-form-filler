// Content script for form detection and auto-fill

let detectedForms = [];
let isProcessing = false;
let fillSnapshot = null; // Previous values snapshot for undo
let fpCounter = 0; // Counter for tagging unnamed fields

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fillForm') {
    fillFormFields(message.formData).then(report => sendResponse(report));
    return true;
  }
  
  if (message.action === 'undoFill') {
    sendResponse(undoLastFill());
    return true;
  }
  
  if (message.action === 'detectForms') {
    const forms = detectAllForms();
    sendResponse({ forms: forms });
    return true;
  }
  
  if (message.action === 'detectBatchRows') {
    sendResponse({ rows: detectBatchRows(), context: getPageContext() });
    return true;
  }
  
  if (message.action === 'fillBatch') {
    fillBatchRows(message.rowsData).then(report => sendResponse(report));
    return true;
  }
});

// Detect all forms on the page
function detectAllForms() {
  detectedForms = [];
  fpCounter = 0;
  const formElements = document.querySelectorAll('form');
  
  formElements.forEach((form, formIndex) => {
    const formInfo = {
      id: form.id || `form_${formIndex}`,
      action: form.action || '',
      method: form.method || '',
      fields: [],
      context: getPageContext()
    };
    
    // Get all form fields (radio/checkbox with same name are merged into groups)
    const fields = form.querySelectorAll('input, select, textarea');
    collectFieldsWithGrouping(fields, formInfo.fields);
    
    // Detect rich text editors in this form
    const richTextEditors = detectRichTextEditors(form);
    richTextEditors.forEach((editor, editorIndex) => {
      formInfo.fields.push(editor);
    });
    
    // Detect ARIA-based custom components (Ant Design / Element Plus etc.)
    detectCustomComponents(form).forEach(comp => formInfo.fields.push(comp));
    
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
    
    // Merge standalone radio/checkbox groups, then collect the rest
    collectFieldsWithGrouping(standaloneFields, standaloneForm.fields);
    
    // Detect standalone rich text editors
    const standaloneEditors = detectRichTextEditors(document.body);
    standaloneEditors.forEach(editor => {
      standaloneForm.fields.push(editor);
    });
    
    // Detect standalone custom components (outside any <form>)
    detectCustomComponents(document.body).forEach(comp => {
      if (!comp._inForm) standaloneForm.fields.push(comp);
    });
    
    if (standaloneForm.fields.length > 0) {
      detectedForms.push(standaloneForm);
    }
  }
  
  return detectedForms;
}

// Collect fields, merging radio/checkbox inputs with the same name into one group entry
function collectFieldsWithGrouping(fieldList, target) {
  const groups = {};
  fieldList.forEach((field, fieldIndex) => {
    if (shouldSkipField(field)) return;
    if ((field.type === 'radio' || field.type === 'checkbox') && field.name) {
      if (!groups[field.name]) {
        groups[field.name] = extractFieldInfo(field, fieldIndex);
        groups[field.name].isGroup = true;
        groups[field.name].options = [];
        target.push(groups[field.name]);
      }
      groups[field.name].options.push({
        value: field.value || 'on',
        label: getFieldLabel(field)
      });
    } else {
      target.push(extractFieldInfo(field, fieldIndex));
    }
  });
}

// Tag an element with a stable unique marker and return the marker name
function tagElement(el) {
  let tag = el.getAttribute('data-fp-field');
  if (!tag) {
    tag = 'fp_' + (fpCounter++);
    el.setAttribute('data-fp-field', tag);
  }
  return tag;
}

// Detect ARIA-based custom form components (Ant Design, Element Plus, MUI, Radix...)
function detectCustomComponents(container) {
  const results = [];
  const candidates = container.querySelectorAll('[role="combobox"], .ant-select-selector, .el-select');
  const kept = [];
  
  candidates.forEach(el => {
    if (el.matches('input, select, textarea')) return;
    // Skip nested duplicates (keep the outermost kept element)
    if (kept.some(k => k.contains(el) || el.contains(k))) return;
    // Skip invisible components
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    kept.push(el);
    // Mark the element so the fill phase routes it to fillCustomComponent
    el.setAttribute('data-fp-custom', 'select');
    
    const innerInput = el.querySelector('input');
    results.push({
      name: el.id || el.getAttribute('name') || tagElement(el),
      type: 'custom-select',
      tagName: el.tagName.toLowerCase(),
      label: el.getAttribute('aria-label') || getNearbyLabel(el) || '',
      placeholder: el.getAttribute('placeholder') || (innerInput ? innerInput.placeholder : '') || '',
      required: el.getAttribute('aria-required') === 'true',
      value: '',
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className : '',
      constraints: {},
      _inForm: !!el.closest('form')
    });
  });
  
  return results;
}

// Get label text near an element (preceding label-like sibling or parent's label)
function getNearbyLabel(el) {
  const wrapper = el.closest('.ant-form-item, .el-form-item, [class*="form-item"], [class*="field"]') || el.parentElement;
  if (!wrapper) return '';
  const labelEl = wrapper.querySelector('label, .ant-form-item-label, .el-form-item__label');
  if (labelEl && !labelEl.contains(el)) return labelEl.textContent.trim().slice(0, 50);
  return '';
}

// Extract information from a form field
function extractFieldInfo(field, index) {
  let fieldName = field.name || field.id || field.getAttribute('data-slot') || '';
  
  // Unnamed fields: tag the DOM element with a unique marker so the fill
  // phase can reliably find it again (fixes "field_N" never matching)
  if (!fieldName) {
    fieldName = tagElement(field);
  }
  
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
    // Validation constraints - used by the rule engine & AI prompt
    constraints: {
      pattern: field.getAttribute('pattern') || '',
      min: field.getAttribute('min') || '',
      max: field.getAttribute('max') || '',
      minlength: field.getAttribute('minlength') || '',
      maxlength: field.getAttribute('maxlength') || '',
      step: field.getAttribute('step') || '',
      accept: field.getAttribute('accept') || '',
      inputmode: field.getAttribute('inputmode') || '',
      autocomplete: field.getAttribute('autocomplete') || '',
      multiple: !!field.multiple
    },
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
  
  // Single checkbox without a group name: boolean field
  if (field.type === 'checkbox' && !field.name) {
    fieldInfo.options = ['true'];
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
  // 1. Associated label via for attribute
  if (field.id) {
    const label = document.querySelector(`label[for="${field.id}"]`);
    if (label && label.textContent.trim()) return label.textContent.trim();
  }
  
  // 2. Parent label wrapper
  const parentLabel = field.closest('label');
  if (parentLabel && parentLabel.textContent.trim()) {
    return parentLabel.textContent.trim();
  }
  
  // 3. ARIA attributes
  if (field.getAttribute('aria-label')) {
    return field.getAttribute('aria-label');
  }
  const labelledBy = field.getAttribute('aria-labelledby');
  if (labelledBy) {
    const ref = document.getElementById(labelledBy.split(/\s+/)[0]);
    if (ref && ref.textContent.trim()) return ref.textContent.trim();
  }
  
  // 4. Label-like text in the nearest wrapper that contains exactly one control
  //    (covers Ant Design / Element Plus / custom div-based layouts)
  let node = field.parentElement;
  for (let depth = 0; node && depth < 3; depth++) {
    const controls = node.querySelectorAll('input, select, textarea, [role="combobox"]');
    if (controls.length === 1) {
      const labelEl = node.querySelector('label, legend, dt, .label, [class*="label"], .ant-form-item-label, .el-form-item__label');
      if (labelEl && !labelEl.contains(field) && labelEl.textContent.trim()) {
        return labelEl.textContent.trim().slice(0, 60);
      }
    }
    node = node.parentElement;
  }
  
  // 5. Preceding sibling text
  const prevElement = field.previousElementSibling;
  if (prevElement) {
    const text = prevElement.textContent.trim();
    if (text && text.length <= 60) return text;
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

// Fill form fields with generated data, returns a fill report
async function fillFormFields(formData) {
  console.log('[FormPilot] Starting to fill fields:', Object.keys(formData).length, 'fields');
  
  isProcessing = true;
  let filledCount = 0;
  const notFound = [];
  const snapshot = [];
  const filledElements = [];
  
  // Get all form fields on the page with their detection indices
  const allFields = getAllFieldsWithIndices();
  
  for (const fieldName of Object.keys(formData)) {
    const value = formData[fieldName];
    console.log(`[FormPilot] Processing: ${fieldName} (${typeof value})`);
    
    // Strategy 1: Try to find by exact name/id match
    let fields = findFieldsByName(fieldName);
    
    // Strategy 2: If not found, try to match by detection index
    if (fields.length === 0) {
      const indexMatch = fieldName.match(/^(\w+)_(\d+)$/);
      if (indexMatch) {
        const [, tagName, index] = indexMatch;
        console.log(`[FormPilot] Trying index-based match: ${tagName}[${index}]`);
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
      console.log(`[FormPilot] Trying placeholder/label match for: ${fieldName}`);
      const matched = findFieldByLabelOrPlaceholder(fieldName, value);
      if (matched) fields = [matched];
    }
    
    // Fill the found field(s)
    if (fields.length > 0) {
      for (const field of fields) {
        // Snapshot previous value for undo
        snapshot.push(captureFieldValue(field));
        if (await fillField(field, value)) {
          filledCount++;
          filledElements.push(field);
          console.log(`[FormPilot] ✅ Filled: ${fieldName}`);
        }
      }
    } else {
      notFound.push(fieldName);
      console.log(`[FormPilot] ❌ Not found: ${fieldName}`);
    }
  }
  
  dispatchFormEvents();
  
  // Keep snapshot for undo
  fillSnapshot = snapshot.length > 0 ? snapshot : null;
  
  // Post-fill validation report
  const invalidFields = validateFilledFields(filledElements);
  
  console.log(`[FormPilot] Completed! Filled ${filledCount}/${Object.keys(formData).length} fields`);
  isProcessing = false;
  
  const report = {
    filledCount,
    totalKeys: Object.keys(formData).length,
    notFound,
    invalidFields,
    canUndo: !!fillSnapshot
  };
  
  if (invalidFields.length > 0) {
    showNotification(`Filled ${filledCount} fields, ${invalidFields.length} failed validation`, 'info');
  } else {
    showNotification(`Successfully filled ${filledCount} fields!`, 'success');
  }
  
  // Watch for multi-step form changes (new fields appearing after step switch)
  startStepWatcher();
  
  return report;
}

// ==================== P3: batch rows (repeated table rows / sibling blocks) ====================

const BATCH_CONTROL_SEL = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea';

// Detect repeating row containers suitable for per-row batch filling
function detectBatchRows() {
  const candidates = [];
  const pushed = new Set();
  const push = (el) => { if (!pushed.has(el)) { pushed.add(el); candidates.push(el); } };

  // 1) Table rows containing controls (>=2 rows per table)
  document.querySelectorAll('table').forEach(table => {
    const trs = Array.from(table.querySelectorAll('tr')).filter(tr => tr.querySelector(BATCH_CONTROL_SEL));
    if (trs.length >= 2) trs.forEach(push);
  });

  // 2) Repeated sibling blocks with the same tag+class signature (non-table layouts)
  document.querySelectorAll('div, ul, section').forEach(container => {
    if (container.closest('table') || container.querySelector('table')) return;
    const kids = Array.from(container.children).filter(k => k.querySelector(BATCH_CONTROL_SEL));
    if (kids.length < 2) return;
    const sig = (k) => k.tagName + '|' + String(k.className).split(/\s+/).slice(0, 3).join('.');
    const counts = {};
    kids.forEach(k => { counts[sig(k)] = (counts[sig(k)] || 0) + 1; });
    kids.forEach(k => { if (counts[sig(k)] >= 2) push(k); });
  });

  // Drop rows that nest other rows (avoid double-filling outer+inner)
  const rowEls = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
  if (rowEls.length < 2) return [];

  return rowEls.map((el, i) => {
    el.setAttribute('data-fp-row', 'r_' + i);
    const fields = [];
    collectFieldsWithGrouping(el.querySelectorAll('input, select, textarea'), fields);
    return { rowId: 'r_' + i, fields };
  });
}

// Fill each row with its own dataset, scoped to the row element
async function fillBatchRows(rowsData) {
  isProcessing = true;
  const snapshot = [];
  const filledElements = [];
  const notFound = [];
  let filledCount = 0;
  let totalKeys = 0;

  for (let i = 0; i < rowsData.length; i++) {
    const rowEl = document.querySelector(`[data-fp-row="r_${i}"]`);
    const data = rowsData[i] || {};
    if (!rowEl) {
      Object.keys(data).forEach(n => { totalKeys++; notFound.push(`row${i}:${n}`); });
      continue;
    }
    for (const name of Object.keys(data)) {
      totalKeys++;
      const safe = attrEscape(name);
      let els = Array.from(rowEl.querySelectorAll(`[name="${safe}"]`));
      if (els.length === 0) els = Array.from(rowEl.querySelectorAll(`[data-fp-field="${safe}"]`));
      if (els.length === 0) { notFound.push(name); continue; }
      for (const field of els) {
        snapshot.push(captureFieldValue(field));
        if (await fillField(field, data[name])) {
          filledCount++;
          filledElements.push(field);
        }
      }
    }
  }

  dispatchFormEvents();
  fillSnapshot = snapshot.length > 0 ? snapshot : null;
  const invalidFields = validateFilledFields(filledElements);
  isProcessing = false;
  showNotification(`Batch filled ${filledCount} fields across ${rowsData.length} rows`, 'success');
  startStepWatcher();
  return {
    filledCount,
    totalKeys,
    notFound,
    invalidFields,
    canUndo: !!fillSnapshot,
    rowCount: rowsData.length
  };
}

function attrEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Capture current value of a field for undo
function captureFieldValue(field) {
  // Custom components have no reliable snapshot - skip them on undo
  if (field.getAttribute && field.getAttribute('data-fp-custom')) {
    return { field, kind: 'custom', value: '' };
  }
  const isRichText = field.type && String(field.type).startsWith('richtext');
  if (isRichText || field.isContentEditable) {
    return { field, kind: 'html', value: field.innerHTML || '' };
  }
  if (field.type === 'checkbox' || field.type === 'radio') {
    return { field, kind: 'checked', value: field.checked };
  }
  return { field, kind: 'value', value: field.value };
}

// Restore values from the last fill snapshot
function undoLastFill() {
  if (!fillSnapshot) {
    return { success: false, error: 'Nothing to undo' };
  }
  
  let restored = 0;
  fillSnapshot.forEach(({ field, kind, value }) => {
    if (kind === 'custom') return; // Custom components cannot be restored
    try {
      if (kind === 'html') {
        field.innerHTML = value;
      } else if (kind === 'checked') {
        field.checked = value;
      } else {
        field.value = value;
      }
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      restored++;
    } catch (e) {
      console.warn('[FormPilot] Undo failed for a field:', e);
    }
  });
  
  dispatchFormEvents();
  fillSnapshot = null;
  showNotification(`Restored ${restored} fields`, 'success');
  return { success: true, restoredCount: restored };
}

// Check HTML5 validity of filled fields and collect error messages
function validateFilledFields(elements) {
  const invalid = [];
  elements.forEach(field => {
    try {
      if (typeof field.checkValidity === 'function' && !field.checkValidity()) {
        invalid.push({
          name: field.name || field.id || getFieldLabel(field) || '(unknown)',
          label: getFieldLabel(field),
          message: field.validationMessage || 'Invalid value',
          value: field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value
        });
      }
    } catch (e) {
      // Rich text / contenteditable elements have no checkValidity - skip
    }
  });
  return invalid;
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
  
  // Search by FormPilot marker (unnamed fields tagged during detection)
  if (fields.length === 0) {
    const byFpTag = document.querySelectorAll(`[data-fp-field="${name}"]`);
    byFpTag.forEach(f => {
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
async function fillField(field, value) {
  if (!value && value !== '' && value !== false) return false;
  
  try {
    const tagName = field.tagName.toLowerCase();
    const type = field.type;
    
    // Handle ARIA custom components (Ant Design / Element Plus selects etc.)
    if (field.getAttribute && field.getAttribute('data-fp-custom') === 'select') {
      return await fillCustomComponent(field, value);
    }
    
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

// ==================== ARIA custom component filling ====================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fireMouse(el, type) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
}

// Fill a custom select-like component: open dropdown, click matching option
async function fillCustomComponent(field, value) {
  try {
    const trigger = field.querySelector('.ant-select-selector') || field;
    fireMouse(trigger, 'mousedown');
    fireMouse(trigger, 'mouseup');
    fireMouse(trigger, 'click');
    if (typeof trigger.focus === 'function') trigger.focus();
    await sleep(350);
    
    // Collect visible dropdown options (rendered in body-level popups)
    const optionSelector = '[role="option"], .ant-select-item-option, .el-select-dropdown__item, li[class*="option"]';
    const visibleOptions = () => Array.from(document.querySelectorAll(optionSelector))
      .filter(o => o.offsetParent !== null && o.textContent.trim());
    
    const target = String(value).trim().toLowerCase();
    let options = visibleOptions();
    let match = options.find(o => o.textContent.trim().toLowerCase() === target)
      || options.find(o => o.textContent.trim().toLowerCase().includes(target))
      || options.find(o => target.includes(o.textContent.trim().toLowerCase()));
    
    // Fallback: searchable combobox - type into the search input
    if (!match) {
      const searchInput = field.querySelector('input') ||
        (document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement : null);
      if (searchInput) {
        searchInput.value = String(value);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(400);
        options = visibleOptions();
        match = options.find(o => o.textContent.trim().toLowerCase().includes(target)) || options[0];
      }
    }
    
    if (match) {
      fireMouse(match, 'mousedown');
      fireMouse(match, 'mouseup');
      fireMouse(match, 'click');
      await sleep(150);
      return true;
    }
    
    // No matching option: close the dropdown
    document.body.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    console.log('[FormPilot] ❌ Custom component: no matching option for', value);
    return false;
  } catch (error) {
    console.error('[FormPilot] Custom component fill error:', error);
    return false;
  }
}

// ==================== Multi-step form watcher ====================

let stepObserver = null;
let knownFieldCount = 0;

// Count currently visible fillable fields
function countVisibleFormFields() {
  let count = 0;
  document.querySelectorAll('input, select, textarea, [role="combobox"]').forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (el.disabled || el.readOnly) return;
    count++;
  });
  return count;
}

// After a fill, watch the DOM for new fields appearing (multi-step forms)
function startStepWatcher() {
  knownFieldCount = countVisibleFormFields();
  if (stepObserver) stepObserver.disconnect();
  
  let timer = null;
  stepObserver = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const now = countVisibleFormFields();
      if (now > knownFieldCount) {
        console.log(`[FormPilot] 📄 Form step changed: ${knownFieldCount} -> ${now} fields`);
        knownFieldCount = now;
        try {
          chrome.runtime.sendMessage({
            action: 'formStepChanged',
            previousCount: knownFieldCount,
            currentCount: now
          }).catch(() => {});
        } catch (e) {
          // Extension context may be invalidated after update - ignore
        }
      }
    }, 800);
  });
  stepObserver.observe(document.body, { childList: true, subtree: true });
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
    console.log(`FormPilot: Detected ${forms.length} form(s) on page`);
  }
}, 1000);
