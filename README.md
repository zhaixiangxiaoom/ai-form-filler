# AI Form Filler - Chrome Extension

A powerful Chrome browser extension that automatically detects form fields on webpages and fills them with AI-generated data using Alibaba Cloud's Bailian (百炼) large language models.

## Features

- 🔍 **Automatic Form Detection**: Scans webpages to identify all form fields including inputs, selects, textareas, radios, checkboxes, and rich text editors
- 🤖 **AI-Powered Data Generation**: Uses Alibaba Cloud's Bailian Qwen models to generate realistic, contextually appropriate form data
- ⚡ **One-Click Form Filling**: Fill entire forms instantly with a single click
- 🌍 **Multi-Language Support**: Generate form data in English, Chinese, Japanese, Korean, Spanish, and French
- ⚙️ **Customizable Settings**: Configure API endpoint, model selection, and language preferences
- 🔒 **Privacy-Focused**: API keys stored locally, no data sent to third parties
- 🎨 **Modern UI**: Clean, intuitive popup interface with real-time form preview

## Installation

### Step 1: Download/Clone the Extension

The extension files are already in your workspace at:
```
/Users/zhaixiangxiao/IdeaProjects/ai-form-filler
```

### Step 2: Add Icon Files (Optional but Recommended)

Create placeholder icons or add your own:
- `icons/icon16.png` (16x16 pixels)
- `icons/icon48.png` (48x48 pixels)
- `icons/icon128.png` (128x128 pixels)

**Note**: The extension will work without icons, but you'll see a default puzzle piece icon in Chrome.

### Step 3: Load Extension in Chrome

1. Open Chrome browser
2. Navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked** button
5. Select the `ai-form-filler` folder
6. The extension icon will appear in your browser toolbar

## Configuration

### Getting an Alibaba Cloud Bailian API Key

1. Visit [Alibaba Cloud Bailian Platform](https://bailian.console.aliyun.com/)
2. Sign up or log in to your account
3. Navigate to API Keys section (API-KEY 管理)
4. Create a new API key
5. Copy the key (you won't be able to see it again!)

### Setting Up the Extension

1. Click the AI Form Filler icon in Chrome toolbar
2. Go to the **Settings** tab
3. Enter your Alibaba Cloud Bailian API key
4. (Optional) Configure:
   - **API URL**: Use default for Bailian (`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`)
   - **AI Model**: Choose between Qwen-Turbo (fast), Qwen-Plus (balanced), or Qwen-Max (best quality)
   - **Language**: Select preferred language for generated data
   - **Auto-fill**: Enable to automatically fill forms when detected
5. Click **Save Settings**

## Usage

### Basic Workflow

1. **Navigate to a webpage** with forms you want to fill
2. **Click the extension icon** to open the popup
3. **Click "Detect Forms"** to scan the page for form fields
4. **Review detected fields** in the preview section
5. **Click "Generate & Fill"** to use AI to generate and fill the form data
6. The form will be automatically filled with realistic data!

### Supported Form Fields

- Text inputs (text, email, phone, url, password, etc.)
- Textareas
- Select dropdowns
- Radio buttons
- Checkboxes
- Number inputs
- Date inputs
- **Rich Text Editors**:
  - TinyMCE
  - CKEditor (4 & 5)
  - Quill
  - Froala
  - Summernote
  - contenteditable divs
  - iframe-based editors

### Advanced Usage

#### Using Custom AI APIs

The extension supports any OpenAI-compatible API. For example:

- **Alibaba Cloud Bailian**: Use default URL `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
- **Azure OpenAI**: Set API URL to `https://your-resource.openai.azure.com/openai/deployments/your-deployment/chat/completions?api-version=2023-05-15`
- **Local LLM**: Point to your local server running compatible models
- **Other Providers**: Any service that implements the OpenAI chat completion API

#### Multi-Language Support

When you select a language in settings, the AI will generate form data in that language:
- Names, addresses, and other locale-specific data will match the selected language
- Perfect for testing internationalization or filling forms in different languages

## Project Structure

```
ai-form-filler/
├── manifest.json          # Extension manifest (Chrome Manifest V3)
├── background.js          # Service worker for AI integration
├── content.js            # Content script for form detection & filling
├── popup.html            # Popup UI
├── popup.css             # Popup styles
├── popup.js              # Popup logic
├── icons/                # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md             # This file
```

## How It Works

1. **Form Detection**: The content script (`content.js`) scans the DOM for form elements and extracts field metadata (name, type, label, placeholder, etc.)

2. **AI Prompt Generation**: The background script (`background.js`) builds a detailed prompt describing all form fields and sends it to the AI model

3. **Data Generation**: The AI generates realistic, contextually appropriate data for each field and returns it as JSON

4. **Form Filling**: The content script receives the generated data and fills each field, triggering appropriate events (input, change) to ensure form validation works

## Security & Privacy

- ✅ API keys are stored in Chrome's local storage (encrypted)
- ✅ No form data is sent to external servers (only field metadata)
- ✅ All processing happens locally in your browser
- ✅ Open-source code - fully transparent

## Troubleshooting

### Extension not detecting forms
- Refresh the page and try again
- Make sure the page has fully loaded
- Check if forms are in iframes (not currently supported)

### AI generation fails
- Verify your API key is correct and has credits
- Check your internet connection
- Try switching to a different model (Qwen-Turbo is more reliable)
- Ensure you're using the correct Bailian API endpoint

### Fields not filling correctly
- Some websites use custom form libraries - try manual filling
- Check browser console for error messages
- The field might be dynamically generated after page load

### API errors
- Ensure your API URL is correct (default: `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`)
- Check if you've exceeded your API rate limit
- Verify the API key has proper permissions
- Check your Alibaba Cloud account balance

## Development

### Testing Locally

1. Make changes to the code
2. Go to `chrome://extensions/`
3. Click the reload icon on the AI Form Filler card
4. Test the changes

### Debugging

- **Popup UI**: Right-click the popup → Inspect
- **Content Script**: Right-click webpage → Inspect → Console
- **Background Script**: Go to `chrome://extensions/` → AI Form Filler → Service Worker

### Building for Production

The extension is ready to use as-is. For Chrome Web Store submission:
1. Create a ZIP file of the extension folder
2. Submit to Chrome Web Store Developer Dashboard
3. Follow Chrome Web Store guidelines

## Future Enhancements

- [ ] Support for CAPTCHA solving
- [ ] Form field mapping templates
- [ ] Save frequently used form data
- [ ] Support for multi-step forms
- [ ] Batch form filling
- [ ] Custom field rules and patterns
- [ ] Integration with other AI providers (Anthropic, Google, etc.)

## License

MIT License - Feel free to modify and distribute

## Support

If you encounter issues or have suggestions:
- Check the troubleshooting section
- Review browser console for errors
- Ensure your API key is valid and has credits

## Disclaimer

This extension is designed for legitimate use cases such as:
- Testing web applications
- Filling registration forms for development
- Automating repetitive data entry tasks

Please use responsibly and in compliance with website terms of service.
