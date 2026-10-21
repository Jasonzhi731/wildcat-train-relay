/**
 * 與後端溝通。正式網站呼叫 Google Apps Script；在自己電腦測試時可改用本機模擬模式。
 */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const host = location.hostname;
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '';
  const forceLocal = new URLSearchParams(location.search).get('local') === '1';
  const isLocal = isLocalHost && (!CFG.API_URL || forceLocal);
  let localReady = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('無法載入 ' + src)); };
      document.head.appendChild(s);
    });
  }

  function ensureLocal() {
    if (!localReady) {
      localReady = loadScript('dev/mock-gas.js')
        .then(function () { return loadScript('apps-script/Code.gs'); })
        .then(function () { return loadScript('dev/local-backend.js'); });
    }
    return localReady;
  }

  async function call(body) {
    if (isLocal) {
      await ensureLocal();
      return window.LocalBackend.call(body);
    }
    if (!CFG.API_URL) throw new Error('網站還沒設定後端網址（js/config.js 的 API_URL），請聯絡管理員');
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 30000) : null;
    try {
      // 用 text/plain 送出，避免瀏覽器先送 CORS 預檢（Apps Script 不支援）
      const resp = await fetch(CFG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!resp.ok) throw new Error('伺服器回應錯誤（HTTP ' + resp.status + '），請稍後再試');
      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error('伺服器回應格式不正確：請確認 Apps Script 已部署為「所有人」都能存取');
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('連線逾時，請檢查網路後再試一次');
      if (e instanceof TypeError) throw new Error('無法連線到伺服器，請檢查網路後再試一次');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  window.Api = {
    isLocal: isLocal,
    call: call,
    ensureLocal: ensureLocal,
  };
})();
