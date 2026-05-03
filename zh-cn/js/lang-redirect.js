;(function () {
  var ROOT_CN_PATH = '/zh-cn/';
  var ROOT_TW_PATH = '/zh-tw/';

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

  function detectCountryCode() {
    return withTimeout(
      fetch('https://api.country.is/', { method: 'GET' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          var code = parseCountryCode(data);
          if (code) return code;
          return fetch('https://ipapi.co/json/', { method: 'GET' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (fallbackData) { return parseCountryCode(fallbackData); })
            .catch(function () { return ''; });
        })
        .catch(function () { return ''; }),
      1500
    ).then(function (code) {
      return code || '';
    });
  }

  function showChooser() {
    var loadingEl = document.getElementById('loading');
    var chooserEl = document.getElementById('lang-chooser');
    if (loadingEl) loadingEl.style.display = 'none';
    if (chooserEl) chooserEl.style.display = 'grid';
  }

  function boot() {
    if (!shouldRedirectFromRoot() || isLocalPreviewHost()) {
      showChooser();
      return;
    }

    detectCountryCode()
      .then(function (code) {
        if (!code) {
          showChooser();
          return;
        }
        if (code === 'CN') {
          window.location.replace(ROOT_CN_PATH);
          return;
        }
        window.location.replace(ROOT_TW_PATH);
      })
      .catch(function () {
        showChooser();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
