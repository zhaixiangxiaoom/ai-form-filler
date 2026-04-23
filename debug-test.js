/**
 * 调试脚本：在浏览器控制台运行此脚本来诊断问题
 * 打开 test-richtext.html，然后在控制台粘贴此代码
 */

console.log('=== AI Form Filler Debug Script ===\n');

// 1. 检查 Quill 编辑器
console.log('1. Checking Quill Editor:');
const quillContainers = document.querySelectorAll('.ql-container');
console.log('   Found .ql-container elements:', quillContainers.length);

quillContainers.forEach((container, index) => {
  console.log(`\n   Container ${index}:`, container);
  console.log('   Has __quill:', !!container.__quill);
  console.log('   __quill instance:', container.__quill);
  
  if (container.__quill) {
    const quill = container.__quill;
    console.log('   Current content:', quill.root.innerHTML);
    console.log('   Methods available:', {
      setText: typeof quill.setText,
      dangerouslyPasteHTML: typeof quill.clipboard?.dangerouslyPasteHTML,
      setContents: typeof quill.setContents
    });
  }
});

// 2. 检查 contenteditable div
console.log('\n2. Checking ContentEditable Div:');
const contentEditable = document.querySelector('[contenteditable="true"]');
console.log('   Found:', contentEditable);
if (contentEditable) {
  console.log('   ID:', contentEditable.id);
  console.log('   Name:', contentEditable.getAttribute('name'));
  console.log('   Current HTML:', contentEditable.innerHTML);
}

// 3. 测试手动填充 Quill
console.log('\n3. Testing manual Quill fill:');
if (quillContainers.length > 0 && quillContainers[0].__quill) {
  const quill = quillContainers[0].__quill;
  const testHTML = '<h2>Test Content</h2><p>This is a <strong>test</strong>.</p>';
  console.log('   Attempting to fill with:', testHTML);
  
  try {
    quill.clipboard.dangerouslyPasteHTML(testHTML);
    console.log('   ✅ Success! Content after fill:', quill.root.innerHTML);
  } catch (error) {
    console.error('   ❌ Error:', error);
  }
}

// 4. 测试手动填充 contenteditable
console.log('\n4. Testing manual contenteditable fill:');
if (contentEditable) {
  const testContent = '<p>Test content for contenteditable</p>';
  console.log('   Attempting to fill with:', testContent);
  
  try {
    contentEditable.innerHTML = testContent;
    contentEditable.dispatchEvent(new Event('input', { bubbles: true }));
    contentEditable.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('   ✅ Success! Content after fill:', contentEditable.innerHTML);
  } catch (error) {
    console.error('   ❌ Error:', error);
  }
}

// 5. 检查所有表单字段
console.log('\n5. All form fields detected:');
const allInputs = document.querySelectorAll('input, textarea, select, [contenteditable="true"]');
console.log('   Total fields:', allInputs.length);
allInputs.forEach((field, index) => {
  console.log(`   Field ${index}:`, {
    tagName: field.tagName,
    type: field.type,
    name: field.name,
    id: field.id,
    placeholder: field.placeholder,
    hasValue: !!field.value,
    value: field.value?.substring(0, 50)
  });
});

console.log('\n=== Debug Complete ===');
