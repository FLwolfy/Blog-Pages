(function () {
  'use strict';

  var STORAGE_KEY = 'zh-auto-variant';
  var OPENCC_CDN = 'https://cdn.jsdelivr.net/npm/opencc-js@1.3.0/dist/umd/full.js';
  var IP_TIMEOUT = 1800;
  var OPENCC_TIMEOUT = 2500;
  var ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];
  var SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'CODE',
    'PRE',
    'KBD',
    'SAMP',
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
    'SVG',
    'CANVAS',
    'IFRAME'
  ]);
  var converted = false;
  var observer = null;
  var converter = null;

  function reveal() {
    if (window.__zhAutoRevealTimer) {
      window.clearTimeout(window.__zhAutoRevealTimer);
      window.__zhAutoRevealTimer = null;
    }
    document.documentElement.classList.remove('zh-auto-pending');
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = window.setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('timeout'));
      }, ms);
      promise.then(function (value) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        resolve(value);
      }, function (err) {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        reject(err);
      });
    });
  }

  function fetchJson(url) {
    return withTimeout(fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    }).then(function (res) {
      if (!res.ok) throw new Error('bad status');
      return res.json();
    }), IP_TIMEOUT);
  }

  function fetchText(url) {
    return withTimeout(fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    }).then(function (res) {
      if (!res.ok) throw new Error('bad status');
      return res.text();
    }), IP_TIMEOUT);
  }

  function normalizeCountry(value) {
    return String(value || '').trim().toUpperCase();
  }

  function detectCountryByIp() {
    var providers = [
      function () {
        return fetchJson('https://api.country.is/').then(function (data) {
          return normalizeCountry(data.country);
        });
      }
    ];

    return new Promise(function (resolve) {
      var pending = providers.length;
      var settled = false;
      providers.forEach(function (provider) {
        provider().then(function (country) {
          if (settled || !country) return;
          settled = true;
          resolve(country);
        }).catch(function () {
          pending -= 1;
          if (!settled && pending <= 0) resolve('');
        });
      });
    });
  }

  function fallbackShouldConvert() {
    var languages = (navigator.languages || [navigator.language || '']).join(',').toLowerCase();
    var timezone = '';
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (err) {
      timezone = '';
    }
    if (timezone === 'Asia/Shanghai' || languages.indexOf('zh-cn') >= 0 || languages.indexOf('zh-hans') >= 0) {
      return false;
    }
    return true;
  }

  function isLocalhost() {
    var host = (window.location.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  function shouldSkipElement(el) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (SKIP_TAGS.has(node.tagName)) return true;
      if (node.classList && (node.classList.contains('no-opencc') || node.classList.contains('no-translate'))) {
        return true;
      }
      if (node.hasAttribute && node.hasAttribute('data-no-opencc')) return true;
    }
    return false;
  }

  function hasChinese(text) {
    return /[\u3400-\u9fff]/.test(text);
  }

  function convertText(text) {
    if (!text || !hasChinese(text)) return text;
    return converter ? converter(text) : text;
  }

  function convertAttributes(el) {
    if (!el || el.nodeType !== 1 || shouldSkipElement(el)) return;
    ATTRS.forEach(function (attr) {
      if (!el.hasAttribute(attr)) return;
      var original = el.getAttribute(attr);
      var next = convertText(original);
      if (next !== original) el.setAttribute(attr, next);
    });
  }

  function convertNode(root) {
    if (!root || !converter) return;

    if (root.nodeType === 3) {
      if (root.parentElement && !shouldSkipElement(root.parentElement)) {
        var nextValue = convertText(root.nodeValue);
        if (nextValue !== root.nodeValue) root.nodeValue = nextValue;
      }
      return;
    }

    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && shouldSkipElement(root)) return;

    if (root.nodeType === 1) convertAttributes(root);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (node) {
        if (node.nodeType === 1) {
          return shouldSkipElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
        return node.parentElement && !shouldSkipElement(node.parentElement)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });

    var current = walker.currentNode;
    while (current) {
      if (current.nodeType === 3) {
        var nextText = convertText(current.nodeValue);
        if (nextText !== current.nodeValue) current.nodeValue = nextText;
      }
      else if (current.nodeType === 1) convertAttributes(current);
      current = walker.nextNode();
    }
  }

  function loadOpenCC() {
    if (window.OpenCC && window.OpenCC.Converter) return Promise.resolve();
    return withTimeout(new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = OPENCC_CDN;
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    }), OPENCC_TIMEOUT);
  }

  function startObserver() {
    if (observer || !window.MutationObserver) return;
    observer = new MutationObserver(function (mutations) {
      if (!converted) return;
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(convertNode);
        if (mutation.type === 'characterData') convertNode(mutation.target);
      });
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function applyTraditional() {
    return loadOpenCC().then(function () {
      if (!window.OpenCC || !window.OpenCC.Converter) throw new Error('OpenCC unavailable');
      converter = window.OpenCC.Converter({ from: 'cn', to: 'twp' });
      converted = true;
      document.documentElement.lang = 'zh-TW';
      document.documentElement.setAttribute('data-zh-auto', 'zh-TW');
      convertNode(document.body || document.documentElement);
      startObserver();
    });
  }

  function decide() {
    var queryVariant = new URLSearchParams(window.location.search).get('zh');
    if (queryVariant === 'cn') return Promise.resolve(false);
    if (queryVariant === 'tw') return Promise.resolve(true);

    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh-CN') return Promise.resolve(false);
    if (saved === 'zh-TW') return Promise.resolve(true);

    return detectCountryByIp().then(function (country) {
      if (country) return country !== 'CN';
      if (isLocalhost()) return true;
      return fallbackShouldConvert();
    });
  }

  function main() {
    decide().then(function (needsConvert) {
      if (!needsConvert) {
        document.documentElement.setAttribute('data-zh-auto', 'zh-CN');
        return null;
      }
      return applyTraditional();
    }).then(function () {
      reveal();
    }).catch(function (err) {
      console.warn('[auto-zh] conversion skipped:', err);
      reveal();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }

  window.setZhAutoVariant = function (variant) {
    if (variant === 'zh-CN' || variant === 'zh-TW') {
      localStorage.setItem(STORAGE_KEY, variant);
      window.location.reload();
    }
  };
})();
