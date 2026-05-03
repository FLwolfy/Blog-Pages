;(function () {
  var ROOT_CN_PATH = '/zh-cn/';
  var ROOT_TW_PATH = '/zh-tw/';
  var STORAGE_KEY = 'zh_variant_pref';

  function normalizeRootPath(path) {
    if (!path) return '/';
    return path.replace(/\/+$/, '') || '/';
  }

  function shouldRedirectFromRoot() {
    var pathName = (window.location && window.location.pathname) ? normalizeRootPath(window.location.pathname) : '/';
    return pathName === '/' || pathName === '/index.html';
  }

  function isLocalPreviewHost() {
    var host = (window.location && window.location.hostname) ? window.location.hostname.toLowerCase() : '';
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (resolve) {
        setTimeout(function () { resolve(null); }, ms);
      })
    ]);
  }

  function parseCountryCode(data) {
    if (!data || typeof data !== 'object') return '';
    var value = data.country_code || data.countryCode || data.country || '';
    return String(value).toUpperCase();
  }

  function fetchCountryCode(url) {
    return fetch(url, { method: 'GET' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { return parseCountryCode(data); })
      .catch(function () { return ''; });
  }

  function detectCountryCode() {
    return withTimeout(
      fetchCountryCode('https://api.country.is/')
        .then(function (code) {
          if (code) return code;
          return fetchCountryCode('https://ipapi.co/json/');
        })
        .catch(function () { return ''; }),
      1500
    ).then(function (code) {
      return code || '';
    });
  }

  function getVariantFromLocalStorage() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'zh-CN') return 'CN';
      if (saved === 'zh-TW') return 'TW';
    } catch (e) {}
    return '';
  }

  function getVariantFromNavigatorLanguage() {
    var lang = (navigator.language || '').toLowerCase();
    if (!lang) return '';
    if (lang === 'zh-cn' || lang.indexOf('zh-hans') >= 0) return 'CN';
    if (lang === 'zh-tw' || lang === 'zh-hk' || lang === 'zh-mo' || lang.indexOf('zh-hant') >= 0) return 'TW';
    return '';
  }

  function showChooser() {
    var loadingEl = document.getElementById('loading');
    var chooserEl = document.getElementById('lang-chooser');
    if (loadingEl) loadingEl.style.display = 'none';
    if (chooserEl) chooserEl.style.display = 'grid';
  }

  function redirectBySignal(signal) {
    if (signal === 'CN') {
      window.location.replace(ROOT_CN_PATH);
      return;
    }
    // Non-local default: always route to zh-tw when not CN.
    window.location.replace(ROOT_TW_PATH);
  }

  function boot() {
    if (!shouldRedirectFromRoot() || isLocalPreviewHost()) {
      showChooser();
      return;
    }

    detectCountryCode()
      .then(function (code) {
        var resolved = code || getVariantFromLocalStorage() || getVariantFromNavigatorLanguage();
        redirectBySignal(resolved);
      })
      .catch(function () {
        var fallback = getVariantFromLocalStorage() || getVariantFromNavigatorLanguage();
        redirectBySignal(fallback);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
