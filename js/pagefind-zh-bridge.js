(function () {
  'use strict';

  var panelObserver = null;
  var resultObserver = null;
  var refreshTimer = null;
  var twToCn = null;
  var twpToCn = null;
  var mountedPanels = new WeakSet();

  function ensureStyle() {
    if (document.getElementById('pf-zh-bridge-style')) return;
    var style = document.createElement('style');
    style.id = 'pf-zh-bridge-style';
    style.textContent = [
      '.pagefind.pf-zh-pending .pagefind-ui__results,.pagefind.pf-zh-pending .pagefind-ui__message{visibility:hidden;}',
      '.pagefind .pagefind-ui__search-input.pf-zh-hidden-source{position:absolute!important;opacity:0!important;pointer-events:none!important;width:1px!important;height:1px!important;padding:0!important;margin:0!important;border:0!important;left:-9999px!important;}'
    ].join('');
    document.head.appendChild(style);
  }

  function ensureConverters() {
    if (twToCn && twpToCn) return;
    if (!window.OpenCC || !window.OpenCC.Converter) return null;
    if (!twToCn) twToCn = window.OpenCC.Converter({ from: 'tw', to: 'cn' });
    if (!twpToCn) twpToCn = window.OpenCC.Converter({ from: 'twp', to: 'cn' });
  }

  function toSimplified(text) {
    if (!text) return text;
    ensureConverters();
    if (!twToCn && !twpToCn) return text;
    try {
      // 兼容 tw / twp 两种写法：优先 tw，再用 twp 兜一遍
      var s = text;
      if (twToCn) s = twToCn(s);
      if (twpToCn) s = twpToCn(s);
      return s;
    } catch (e) {
      return text;
    }
  }

  function scheduleRefresh(panel) {
    if (!panel || !window.AutoZh || typeof window.AutoZh.refresh !== 'function') {
      panel.classList.remove('pf-zh-pending');
      return;
    }
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(function () {
      refreshTimer = null;
      window.AutoZh.refresh(panel).catch(function () {
        // noop
      }).finally(function () {
        panel.classList.remove('pf-zh-pending');
      });
    }, 40);
  }

  function bindResultObserver(panel) {
    if (resultObserver) return;
    resultObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type !== 'childList') continue;
        if ((m.addedNodes && m.addedNodes.length) || (m.removedNodes && m.removedNodes.length)) {
          scheduleRefresh(panel);
          break;
        }
      }
    });
    resultObserver.observe(panel, { childList: true, subtree: true });
  }

  function installProxyInput(panel) {
    var sourceInput = panel.querySelector('.pagefind-ui__search-input');
    if (!sourceInput || sourceInput.dataset.pfZhSourceBound === '1') return;

    var proxyInput = document.createElement('input');
    proxyInput.type = 'text';
    proxyInput.className = sourceInput.className;
    proxyInput.classList.add('pf-zh-proxy-input');
    proxyInput.value = sourceInput.value || '';
    proxyInput.placeholder = sourceInput.placeholder || '';
    proxyInput.autocomplete = sourceInput.autocomplete || 'off';
    proxyInput.autocapitalize = sourceInput.autocapitalize || 'none';
    proxyInput.enterKeyHint = sourceInput.enterKeyHint || 'search';

    sourceInput.classList.add('pf-zh-hidden-source');
    sourceInput.dataset.pfZhSourceBound = '1';

    var form = sourceInput.closest('.pagefind-ui__form');
    if (!form) return;
    form.insertBefore(proxyInput, sourceInput);

    proxyInput.addEventListener('input', function () {
      var raw = proxyInput.value || '';
      var simplified = toSimplified(raw);
      panel.classList.add('pf-zh-pending');

      sourceInput.value = simplified;
      sourceInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }, true);
  }

  function mountPanel(panel) {
    if (!panel || mountedPanels.has(panel)) return;
    mountedPanels.add(panel);
    installProxyInput(panel);
    bindResultObserver(panel);
  }

  function mount() {
    ensureStyle();
    var panel = document.querySelector('.pagefind');
    if (!panel) return;
    mountPanel(panel);
  }

  function init() {
    panelObserver = new MutationObserver(function () {
      mount();
    });
    panelObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    mount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
