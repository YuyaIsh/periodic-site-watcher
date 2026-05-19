(function () {
  var LOGIN_HOSTS = ['login.account.rakuten.com', 'eu.login.account.rakuten.com'];
  var WAIT_MS = 15000;
  var POLL_MS = 150;

  function sendResult(payload) {
    try {
      chrome.runtime.sendMessage(payload);
    } catch (e) {
      /* ignore */
    }
  }

  function isAccountLoginHost(href) {
    try {
      var h = new URL(href).hostname;
      return LOGIN_HOSTS.indexOf(h) !== -1;
    } catch (e) {
      return false;
    }
  }

  function findPasswordInput() {
    return (
      document.querySelector('input#password_current') ||
      document.querySelector('input[name="password"]') ||
      document.querySelector('input[type="password"]')
    );
  }

  function findSubmitButton() {
    return (
      document.querySelector('#cta011') ||
      document.querySelector('.h4k5-e2e-button__submit')
    );
  }

  /** ウィジェット描画待ち: パスワード欄と送信ボタンの両方が揃うまでポーリング */
  function waitForLoginForm() {
    var deadline = Date.now() + WAIT_MS;
    return new Promise(function (resolve) {
      function tick() {
        var input = findPasswordInput();
        var btn = findSubmitButton();
        if (input && btn) {
          resolve({ input: input, btn: btn });
          return;
        }
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        setTimeout(tick, POLL_MS);
      }
      tick();
    });
  }

  async function run() {
    var url = window.location.href || '';

    if (!isAccountLoginHost(url)) {
      sendResult({ type: 'RAKUTEN_LOGIN_RESULT', didLogin: false });
      return;
    }

    var form = await waitForLoginForm();
    if (!form) {
      sendResult({
        type: 'RAKUTEN_LOGIN_RESULT',
        error:
          'ログイン画面のパスワード入力または送信ボタンが見つかりません（読み込み待ちタイムアウト）'
      });
      return;
    }

    var storage = await chrome.storage.local.get('settings');
    var site =
      storage.settings && storage.settings.sites
        ? storage.settings.sites['rakuten-card']
        : null;
    var pwd = site && site.loginPassword ? String(site.loginPassword).trim() : '';

    if (!pwd) {
      sendResult({
        type: 'RAKUTEN_LOGIN_RESULT',
        error: 'ログイン情報が未設定です'
      });
      return;
    }

    form.input.value = pwd;
    form.input.dispatchEvent(new Event('input', { bubbles: true }));
    form.input.dispatchEvent(new Event('change', { bubbles: true }));
    form.btn.click();
    sendResult({ type: 'RAKUTEN_LOGIN_RESULT', didLogin: true });
  }

  run();
})();
