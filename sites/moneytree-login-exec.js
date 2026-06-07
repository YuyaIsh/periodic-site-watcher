(function () {
  var LOGIN_HOST = 'myaccount.getmoneytree.com';
  var WAIT_MS = 15000;
  var POLL_MS = 150;

  function sendResult(payload) {
    try {
      chrome.runtime.sendMessage(payload);
    } catch (e) {
      /* ignore */
    }
  }

  function isMoneytreeLoginHost(href) {
    try {
      var u = new URL(href);
      return u.hostname === LOGIN_HOST && u.pathname.indexOf('/login') !== -1;
    } catch (e) {
      return false;
    }
  }

  function findLoginForm() {
    return document.querySelector('[data-testid="password-login-form"]');
  }

  function waitForLoginForm() {
    var deadline = Date.now() + WAIT_MS;
    return new Promise(function (resolve) {
      function tick() {
        var form = findLoginForm();
        var email = form && form.querySelector('input[name="guest[email]"]');
        var password = form && form.querySelector('input[name="guest[password]"]');
        var submit = form && form.querySelector('button[type="submit"]');
        if (form && email && password && submit) {
          resolve({ form: form, email: email, password: password, submit: submit });
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

    if (!isMoneytreeLoginHost(url) && !findLoginForm()) {
      sendResult({ type: 'MONEYTREE_LOGIN_RESULT', didLogin: false });
      return;
    }

    var fields = await waitForLoginForm();
    if (!fields) {
      sendResult({
        type: 'MONEYTREE_LOGIN_RESULT',
        error: 'Moneytree ログイン画面の入力欄が見つかりません（読み込み待ちタイムアウト）'
      });
      return;
    }

    var site = window.__EFFECTIVE_SITE__ || null;
    var email = site && site.loginEmail ? String(site.loginEmail).trim() : '';
    var pwd = site && site.loginPassword ? String(site.loginPassword).trim() : '';

    if (!email || !pwd) {
      sendResult({
        type: 'MONEYTREE_LOGIN_RESULT',
        error: 'Moneytree ログイン情報（メール・パスワード）が未設定です'
      });
      return;
    }

    fields.email.value = email;
    fields.email.dispatchEvent(new Event('input', { bubbles: true }));
    fields.email.dispatchEvent(new Event('change', { bubbles: true }));

    fields.password.value = pwd;
    fields.password.dispatchEvent(new Event('input', { bubbles: true }));
    fields.password.dispatchEvent(new Event('change', { bubbles: true }));

    var remember = fields.form.querySelector('input[name="guest[remember_me]"]');
    if (remember && !remember.checked) {
      remember.click();
    }

    fields.submit.disabled = false;
    fields.submit.click();
    sendResult({ type: 'MONEYTREE_LOGIN_RESULT', didLogin: true });
  }

  run();
})();
