(function () {
  'use strict';

  var OPENCC_CDN = 'https://cdn.jsdelivr.net/npm/opencc-js@1.3.0/dist/umd/full.js';
  var IP_TIMEOUT = 1800;
  var ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];

  // ==============================
  // 转换策略（唯一真源）
  // ==============================
  var SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'CODE',
    'PRE',
    'KBD',
    'SAMP',
    'SELECT',
    'OPTION',
    'SVG',
    'CANVAS',
    'IFRAME'
  ]);

  // 不转换清单：命中即跳过
  var SKIP_SELECTORS = [
    '.no-opencc',
    '.no-translate',
    '[data-no-opencc]',
    '#new-comment .item',
    '#comments .wl-content',
    '#comments .wl-nick',
    '#comments .tk-content',
    '#comments .tk-nick',
    '#comments .tk-nick-link'
  ];

  // 强制转换清单：命中即转换（优先级高于 SKIP）
  var FORCE_SELECTORS = [
    '#comments textarea',
    '#comments input',
    '#comments [contenteditable="true"]',
    '#comments .wl-editor',
    '#comments .wl-input'
  ];

  var converter = null;
  var openCCPromise = null;
  var readyPromise = null;
  var observer = null;
  var refreshTimer = null;
  var pendingRefreshRoot = null;
  var observedRoots = new WeakSet();
  var convertedText = new WeakMap();
  var convertedAttrs = new WeakMap();

  // 在最早阶段先挂起，避免出现“先简后繁”闪烁。
  if (!document.documentElement.classList.contains('zh-auto-pending')) {
    document.documentElement.classList.add('zh-auto-pending');
  }

  function reveal() {
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

  function hasChinese(text) {
    return /[\u3400-\u9fff]/.test(text);
  }

  function matchesAnySelector(el, selectors) {
    if (!el || !el.matches) return false;
    for (var i = 0; i < selectors.length; i++) {
      if (el.matches(selectors[i])) return true;
    }
    return false;
  }

  function shouldForceElement(el) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (matchesAnySelector(node, FORCE_SELECTORS)) return true;
    }
    return false;
  }

  function shouldSkipElement(el) {
    if (shouldForceElement(el)) return false;

    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (SKIP_TAGS.has(node.tagName)) return true;
      if (matchesAnySelector(node, SKIP_SELECTORS)) return true;
    }
    return false;
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
    openCCPromise = new Promise(function (resolve, reject) {
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
    });
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
    // 严格仅使用 IP 判定：失败则不转换。
    return detectCountryByIp().then(function (country) {
      if (!country) return false;
      return country !== 'CN';
    });
  }

  function maybeAwait(fn, fallbackCtx) {
    if (typeof fn !== 'function') return Promise.resolve();
    try {
      return Promise.resolve(fn(fallbackCtx));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function convertRegion(options) {
    var opts = options || {};
    var root = opts.root || document.getElementById('main') || document.body;
    return init().then(function (enabled) {
      if (!enabled) return false;
      return maybeAwait(opts.beforeRender, { root: root, enabled: true }).then(function () {
        refresh(root);
        return maybeAwait(opts.afterRender, { root: root, enabled: true }).then(function () {
          return true;
        });
      });
    });
  }

  function init() {
    if (readyPromise) return readyPromise;
    readyPromise = Promise.all([decide(), loadOpenCC()]).then(function (results) {
      var needsConvert = results[0];
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
    }).catch(function (error) {
      console.error('[AutoZh] Initialization failed; page remains hidden.', error);
      return false;
    });
    return readyPromise;
  }

  window.AutoZh = {
    ready: init(),
    refresh: function (root) {
      return convertRegion({ root: root });
    },
    convertRegion: convertRegion,
    config: {
      skipSelectors: SKIP_SELECTORS,
      forceSelectors: FORCE_SELECTORS
    }
  };
})();
