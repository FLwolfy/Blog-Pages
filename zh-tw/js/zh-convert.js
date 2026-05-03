/* global OpenCC */
(function () {
  var STORAGE_KEY = 'zh_variant_pref';
  var SCRIPT_ID = 'opencc-js-cdn';
  var OPENCC_CDN = 'https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/full.js';
  var EXCLUDE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA', 'INPUT', 'OPTION', 'SELECT', 'NOSCRIPT'
  ]);
  var EXCLUDE_CLASS = 'no-opencc';

  var twConverter = null;
  var cnConverter = null;
  var observer = null;
  var originalTextMap = new WeakMap();
  var activeVariant = null;
  var convertTimer = null;

  function shouldUseTraditionalByLocale() {
    var lang = (navigator.language || '').toLowerCase();
    return lang === 'zh-tw' || lang === 'zh-hk' || lang === 'zh-mo';
  }

  function getPreferredVariant() {
    var pathName = (window.location && window.location.pathname) ? window.location.pathname : '';
    if (pathName.startsWith('/zh_tw/')) return 'zh-TW';
    if (pathName === '/zh_tw') return 'zh-TW';
    if (pathName.startsWith('/zh_cn/')) return 'zh-CN';
    if (pathName === '/zh_cn') return 'zh-CN';
    if (pathName.startsWith('/zh-tw/')) return 'zh-TW';
    if (pathName === '/zh-tw') return 'zh-TW';
    if (pathName.startsWith('/zh-cn/')) return 'zh-CN';
    if (pathName === '/zh-cn') return 'zh-CN';

    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh-CN' || saved === 'zh-TW') return saved;
    return shouldUseTraditionalByLocale() ? 'zh-TW' : 'zh-CN';
  }


  function isExcludedNode(node) {
    var p = node.parentElement;
    while (p) {
      if (EXCLUDE_TAGS.has(p.tagName)) return true;
      if (p.classList && p.classList.contains(EXCLUDE_CLASS)) return true;
      p = p.parentElement;
    }
    return false;
  }

  function textWalker(root, fn) {
    if (!root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node || !node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (isExcludedNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var current;
    while ((current = walker.nextNode())) fn(current);
  }

  function convertText(text, variant) {
    if (variant === 'zh-TW') return twConverter ? twConverter(text) : text;
    return cnConverter ? cnConverter(text) : text;
  }

  function convertDom(root, variant) {
    textWalker(root, function (node) {
      if (!originalTextMap.has(node)) originalTextMap.set(node, node.nodeValue);
      var raw = originalTextMap.get(node) || node.nodeValue;
      node.nodeValue = convertText(raw, variant);
    });
  }

  function convertTitle(variant) {
    var title = document.title || '';
    if (!title) return;
    if (!window.__zhOriginalTitle) window.__zhOriginalTitle = title;
    document.title = convertText(window.__zhOriginalTitle, variant);
  }

  function applyVariant(variant) {
    activeVariant = variant;
    // Keep lang aligned with Pagefind language keys (zh-tw / zh-cn indexes).
    document.documentElement.setAttribute('lang', variant === 'zh-TW' ? 'zh-TW' : 'zh-CN');
    convertDom(document.body || document.documentElement, variant);
    convertTitle(variant);
  }

  function scheduleApplyVariant(variant) {
    if (convertTimer) clearTimeout(convertTimer);
    convertTimer = setTimeout(function () {
      applyVariant(variant);
      convertTimer = null;
    }, 0);
  }

  function loadOpenCC() {
    return new Promise(function (resolve, reject) {
      if (window.OpenCC) return resolve();
      var existing = document.getElementById(SCRIPT_ID);
      if (existing) {
        existing.addEventListener('load', function () { resolve(); }, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      var script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = OPENCC_CDN;
      script.async = true;
      script.onload = function () { resolve(); };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  function initConverters() {
    if (!window.OpenCC || !window.OpenCC.Converter) return false;
    // Use phrase-aware Taiwan conversion in both directions.
    twConverter = window.OpenCC.Converter({ from: 'cn', to: 'twp' });
    cnConverter = window.OpenCC.Converter({ from: 'twp', to: 'cn' });
    return true;
  }

  function observeDomChanges() {
    if (observer || !(document.body || document.documentElement)) return;
    observer = new MutationObserver(function (mutations) {
      var hasRelevantMutation = mutations.some(function (m) {
        return m.type === 'childList' || (m.type === 'characterData' && m.target && m.target.nodeType === Node.TEXT_NODE);
      });
      if (!hasRelevantMutation) return;
      scheduleApplyVariant(activeVariant || getPreferredVariant());
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function bindLifecycle() {
    document.addEventListener('pjax:success', function () {
      scheduleApplyVariant(activeVariant || getPreferredVariant());
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) scheduleApplyVariant(activeVariant || getPreferredVariant());
    });
  }

  function exposeApi() {
    window.setChineseVariant = function (variant) {
      if (variant !== 'zh-CN' && variant !== 'zh-TW') return;
      localStorage.setItem(STORAGE_KEY, variant);
      scheduleApplyVariant(variant);
    };
    window.getChineseVariant = function () {
      return activeVariant || getPreferredVariant();
    };
  }

  function boot() {
    loadOpenCC()
      .then(function () {
        if (!initConverters()) return;
        exposeApi();
        bindLifecycle();
        observeDomChanges();
        scheduleApplyVariant(getPreferredVariant());
      })
      .catch(function (err) {
        console.warn('[zh-convert] OpenCC load failed:', err);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
