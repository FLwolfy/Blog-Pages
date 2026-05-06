(function () {
  'use strict';

  var STORAGE_KEY = 'zh-auto-variant';
  var DECISION_KEY = 'zh-auto-detected';
  var DECISION_TTL = 7 * 24 * 60 * 60 * 1000;
  var OPENCC_CDN = 'https://cdn.jsdelivr.net/npm/opencc-js@1.3.0/dist/umd/full.js';
  var IP_TIMEOUT = 1800;
  var OPENCC_TIMEOUT = 2500;
  var ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];
  var USER_CONTENT_SELECTOR = [
    '#new-comment .item',
    '#comments .wl-content',
    '#comments .wl-nick',
    '#comments .tk-content',
    '#comments .tk-nick',
    '#comments .tk-nick-link'
  ].join(',');
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
  var converter = null;
  var openCCPromise = null;
  var readyPromise = null;
  var observer = null;
  var refreshTimer = null;
  var pendingRefreshRoot = null;
  var observedRoots = new WeakSet();
  var convertedText = new WeakMap();
  var convertedAttrs = new WeakMap();

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

  function normalizeCountry(value) {
    return String(value || '').trim().toUpperCase();
  }

  function detectCountryByIp() {
    return fetchJson('https://api.country.is/').then(function (data) {
      return normalizeCountry(data.country);
    }).catch(function () {
      return '';
    });
  }

  function isLocalhost() {
    var host = (window.location.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  function readDetectedDecision() {
    try {
      var raw = localStorage.getItem(DECISION_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || Date.now() - data.time > DECISION_TTL) return null;
      return data.variant === 'zh-TW';
    } catch (err) {
      return null;
    }
  }

  function saveDetectedDecision(needsConvert) {
    try {
      localStorage.setItem(DECISION_KEY, JSON.stringify({
        variant: needsConvert ? 'zh-TW' : 'zh-CN',
        time: Date.now()
      }));
    } catch (err) {}
  }

  function shouldSkipElement(el) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (SKIP_TAGS.has(node.tagName)) return true;
      if (node.classList && (node.classList.contains('no-opencc') || node.classList.contains('no-translate'))) {
        return true;
      }
      if (node.matches && node.matches(USER_CONTENT_SELECTOR)) return true;
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

  function convertTextNode(node) {
    if (!node || !node.parentElement || shouldSkipElement(node.parentElement)) return;
    if (convertedText.get(node) === node.nodeValue) return;
    var nextValue = convertText(node.nodeValue);
    if (nextValue !== node.nodeValue) node.nodeValue = nextValue;
    convertedText.set(node, node.nodeValue);
  }

  function convertAttributes(el) {
    if (!el || el.nodeType !== 1 || shouldSkipElement(el)) return;
    var state = convertedAttrs.get(el);
    if (!state) {
      state = {};
      convertedAttrs.set(el, state);
    }
    ATTRS.forEach(function (attr) {
      if (!el.hasAttribute(attr)) return;
      var original = el.getAttribute(attr);
      if (state[attr] === original) return;
      var next = convertText(original);
      if (next !== original) el.setAttribute(attr, next);
      state[attr] = el.getAttribute(attr);
    });
  }

  function refresh(root) {
    if (!converter) return;
    var target = root || document.getElementById('main') || document.body || document.documentElement;

    if (target.nodeType === 3) {
      convertTextNode(target);
      return;
    }

    if (target.nodeType !== 1 && target.nodeType !== 9 && target.nodeType !== 11) return;
    if (target.nodeType === 1 && shouldSkipElement(target)) return;

    if (target.nodeType === 1) convertAttributes(target);

    var walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
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
      if (current.nodeType === 3) convertTextNode(current);
      else if (current.nodeType === 1) convertAttributes(current);
      current = walker.nextNode();
    }
  }

  function loadOpenCC() {
    if (window.OpenCC && window.OpenCC.Converter) return Promise.resolve();
    if (openCCPromise) return openCCPromise;
    openCCPromise = withTimeout(new Promise(function (resolve, reject) {
      var script = document.querySelector('script[data-auto-zh-opencc]');
      if (script) {
        script.addEventListener('load', resolve, { once: true });
        script.addEventListener('error', reject, { once: true });
        return;
      }
      script = document.createElement('script');
      script.src = OPENCC_CDN;
      script.async = true;
      script.setAttribute('data-auto-zh-opencc', 'true');
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    }), OPENCC_TIMEOUT);
    return openCCPromise;
  }

  function applyTraditional() {
    return loadOpenCC().then(function () {
      if (!window.OpenCC || !window.OpenCC.Converter) throw new Error('OpenCC unavailable');
      if (!converter) converter = window.OpenCC.Converter({ from: 'cn', to: 'twp' });
      document.documentElement.lang = 'zh-TW';
      document.documentElement.setAttribute('data-zh-auto', 'zh-TW');
      refresh(document.body || document.documentElement);
      startPjaxObserver();
    });
  }

  function getRefreshRoot(node) {
    if (!node) return null;
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return null;
    if (el.closest) {
      var scoped = el.closest('#comments, #new-comment, .pjax, #main');
      if (scoped) return scoped;
    }
    return document.getElementById('main') || document.body;
  }

  function mergeRefreshRoot(current, next) {
    if (!current) return next;
    if (!next || current === next) return current;
    if (current.contains && current.contains(next)) return current;
    if (next.contains && next.contains(current)) return next;
    return document.body || document.documentElement;
  }

  function scheduleRefresh(root) {
    if (!converter) return;
    var target = root || document.getElementById('main') || document.body;
    pendingRefreshRoot = mergeRefreshRoot(pendingRefreshRoot, target);
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(function () {
      var nextRoot = pendingRefreshRoot || target;
      pendingRefreshRoot = null;
      refreshTimer = null;
      refresh(nextRoot);
    }, 80);
  }

  function observeDynamicRoots() {
    if (!observer) return;
    var roots = [document.body || document.documentElement].concat(
      Array.prototype.slice.call(document.querySelectorAll('#comments, #new-comment'))
    ).filter(Boolean);
    roots.forEach(function (root) {
      if (observedRoots.has(root)) return;
      observedRoots.add(root);
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true
      });
    });
  }

  function startPjaxObserver() {
    if (!window.MutationObserver) return;
    if (!observer) {
      observer = new MutationObserver(function (mutations) {
        var root = null;
        mutations.forEach(function (mutation) {
          root = mergeRefreshRoot(root, getRefreshRoot(mutation.target));
          Array.prototype.forEach.call(mutation.addedNodes, function (node) {
            root = mergeRefreshRoot(root, getRefreshRoot(node));
          });
        });
        observeDynamicRoots();
        if (root) scheduleRefresh(root);
      });
    }
    observeDynamicRoots();
    window.addEventListener('popstate', function () {
      window.setTimeout(function () {
        observeDynamicRoots();
        scheduleRefresh(document.getElementById('main') || document.body);
      }, 120);
    }, { passive: true });
  }

  function decide() {
    var queryVariant = new URLSearchParams(window.location.search).get('zh');
    if (queryVariant === 'cn') return Promise.resolve(false);
    if (queryVariant === 'tw') return Promise.resolve(true);

    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh-CN') return Promise.resolve(false);
    if (saved === 'zh-TW') return Promise.resolve(true);

    var cached = readDetectedDecision();
    if (cached !== null) return Promise.resolve(cached);

    return detectCountryByIp().then(function (country) {
      var needsConvert = country ? country !== 'CN' : isLocalhost();
      saveDetectedDecision(needsConvert);
      return needsConvert;
    });
  }

  function init() {
    if (readyPromise) return readyPromise;
    readyPromise = decide().then(function (needsConvert) {
      if (!needsConvert) {
        document.documentElement.setAttribute('data-zh-auto', 'zh-CN');
        return false;
      }
      return applyTraditional().then(function () {
        return true;
      });
    }).then(function (converted) {
      reveal();
      return converted;
    }).catch(function () {
      reveal();
      return false;
    });
    return readyPromise;
  }

  window.AutoZh = {
    ready: init(),
    refresh: function (root) {
      return init().then(function (enabled) {
        if (enabled) refresh(root);
        return enabled;
      });
    },
    clearCache: function () {
      localStorage.removeItem(DECISION_KEY);
    }
  };

  window.setZhAutoVariant = function (variant) {
    if (variant === 'zh-CN' || variant === 'zh-TW') {
      localStorage.setItem(STORAGE_KEY, variant);
      localStorage.removeItem(DECISION_KEY);
      window.location.reload();
    }
  };
})();
