// FormPilot data assets: personas, site templates, custom rules
// Loaded into the background service worker via importScripts.

const ASSETS_KEY = 'assets';

const DEFAULT_ASSETS = {
  personas: [],        // [{id, name, type:'real'|'random', fields:{semantic:value}, createdAt}]
  activePersonaId: null,
  templates: [],       // [{id, domain, data:{fieldName:value}, semanticData:{semantic:value}, usageCount, lastUsedAt, createdAt}]
  rules: []            // [{id, scope:'global'|'domain', domain, matchType:'semantic'|'name'|'label', matchValue, value, enabled}]
};

function loadAssets() {
  return new Promise((resolve) => {
    chrome.storage.local.get([ASSETS_KEY], (result) => {
      resolve(Object.assign({}, DEFAULT_ASSETS, result[ASSETS_KEY]));
    });
  });
}

function saveAssets(assets) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [ASSETS_KEY]: assets }, resolve);
  });
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

// Build a random but internally consistent test identity via the rule engine
function buildRandomPersona(language) {
  const gen = (semantic) => generateByRules(
    { name: semantic, type: 'text', tagName: 'input', constraints: {} },
    semantic,
    language || 'zh'
  );
  const fields = {
    name: gen('name'),
    email: gen('email'),
    phone: gen('phone'),
    address: gen('address'),
    city: gen('city'),
    company: gen('company'),
    username: gen('username'),
    zipcode: gen('zipcode'),
    url: gen('url')
  };
  return {
    id: uid('persona'),
    name: '随机身份 · ' + fields.name,
    type: 'random',
    fields,
    createdAt: Date.now()
  };
}

// Find the first enabled user rule matching a field
function matchRule(rules, field, semantic, domain) {
  const label = (field.label || '').toLowerCase();
  const name = (field.name || '').toLowerCase();
  return (rules || []).find(r => {
    if (!r.enabled) return false;
    if (r.scope === 'domain' && r.domain !== domain) return false;
    const mv = (r.matchValue || '').toLowerCase();
    if (!mv) return false;
    if (r.matchType === 'semantic') return mv === semantic;
    if (r.matchType === 'name') return name.includes(mv);
    if (r.matchType === 'label') return label.includes(mv);
    return false;
  });
}

// Common semantic types offered in the rule editor UI
const SEMANTIC_OPTIONS = [
  'email', 'phone', 'name', 'username', 'company', 'address',
  'city', 'zipcode', 'url', 'date', 'number'
];
