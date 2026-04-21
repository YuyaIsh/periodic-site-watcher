// 共通ユーティリティを読み込む（Service WorkerではimportScriptsを使用）
importScripts(
  'utils/schedule.js',
  'utils/validation.js',
  'utils/slack.js',
  'utils/options-api-log.js'
);

/** ログ出力の統一プレフィックス（SW・sites/共通で利用） */
const LOG_PREFIX = '[サイト巡回]';

/**
 * サイト巡回ログ用のメタ情報行を組み立てる
 * @param {string} siteId - サイトID
 * @param {'schedule'|'manual'} invokedBy - 起動経路（省略時は 'schedule'）
 * @param {boolean} mockMode - モックモード
 * @param {boolean} localMode - ローカル手動（localMode時はmockModeはfalse扱い）
 * @returns {string} ログ用の識別行（例: "[サイト巡回] moneyforward (スケジュール/モック)"）
 */
function formatSiteLogMeta(siteId, invokedBy, mockMode, localMode) {
  const invoked = invokedBy === 'manual' ? '手動' : 'スケジュール';
  const mode = localMode ? 'ローカル' : (mockMode ? 'モック' : '通常');
  return `${LOG_PREFIX} ${siteId} (${invoked}/${mode})`;
}

/**
 * タブ内で出た console を SW に転写し、外部 API 送信用オブジェクトからは除去する
 * @param {string} siteId
 * @param {Object} [envelope] - collectOnPage の戻り（collectLogs を含みうる）
 */
function emitCollectLogsAndStrip(siteId, envelope) {
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'collectLogs')) {
    return;
  }
  const logs = envelope.collectLogs;
  if (Array.isArray(logs) && logs.length > 0) {
    for (const entry of logs) {
      const line = `${siteId} ${entry.text}`;
      const lv = entry.level || 'log';
      if (lv === 'warn') {
        console.warn(`${LOG_PREFIX} [ページ]`, line);
      } else if (lv === 'error') {
        console.error(`${LOG_PREFIX} [ページ]`, line);
      } else {
        console.log(`${LOG_PREFIX} [ページ]`, line);
      }
    }
  } else if (
    siteId === 'rakuten-card' &&
    Array.isArray(logs) &&
    logs.length === 0
  ) {
    console.warn(
      `${LOG_PREFIX} [ページ]`,
      `${siteId} ページ側の console.log を0行しか取り込めませんでした（拡張を再読み込みして再試行）`
    );
  }
  delete envelope.collectLogs;
}

/**
 * Storageの初期化と整合性チェック
 * 
 * settingsとstateは分離されているが、サイトが追加された場合に
 * state側のnextRunが未初期化だと実行判定ができない。
 * そのため、settingsに存在するがstateに存在しないサイトに対して
 * スケジュールに基づいたnextRunを自動設定する。
 * 
 * この関数は起床処理のたびに呼ばれるが、既存データの上書きはしないため
 * パフォーマンスへの影響は軽微。
 * 
 * @returns {Promise<{settings: Object, state: Object}>} 初期化済みの設定と状態
 */
async function initializeStorage() {
  const result = await chrome.storage.local.get(['settings', 'state']);
  const now = Date.now();
  
  if (!result.settings || !result.settings.sites) {
    const defaultSettings = {
      sites: {}
    };
    await chrome.storage.local.set({ settings: defaultSettings });
    result.settings = defaultSettings;
  }
  
  if (!result.state || !result.state.bySite) {
    result.state = { bySite: {} };
  }
  
  // 新規追加されたサイトのnextRunを初期化（既存のnextRunは保持）
  for (const siteId of Object.keys(result.settings.sites)) {
    if (!result.state.bySite[siteId]) {
      const site = result.settings.sites[siteId];
      result.state.bySite[siteId] = {
        nextRun: computeNextRunAfterSuccess(now, site.schedule)
      };
    }
  }
  
  await chrome.storage.local.set({ state: result.state });
  return { settings: result.settings, state: result.state };
}

/**
 * @param {number} tabId
 * @param {number} timeoutSec
 * @returns {Promise<void>}
 */
function waitForTabComplete(tabId, timeoutSec) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(`Timeout after ${timeoutSec} seconds`));
      }
    }, timeoutSec * 1000);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete' && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then((tabInfo) => {
      if (tabInfo.status === 'complete' && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
  });
}

/**
 * 非アクティブタブでは Page Visibility / タイマー抑制で明細のクライアント描画が遅延しやすいため、
 * 楽天カード巡回時は対象タブを選択状態にする。
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function activateRakutenStatementTab(tabId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (_) {
    /* タブが既に閉じている等 */
  }
}

/**
 * tabs の complete 直後でも明細はクライアント描画で遅れることがあるため、
 * 明細 UI が DOM に現れるまで待つ（空のまま collect してタブだけ閉じるのを防ぐ）。
 *
 * @param {number} tabId
 * @param {number} timeoutSec
 * @returns {Promise<void>}
 */
async function waitForRakutenStatementDom(tabId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  const pollMs = 250;
  let sawStatement = false;
  while (Date.now() < deadline) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const hasStatement = !!(
            document.querySelector('#statement-month') ||
            document.querySelector('.stmt-payment-lists__i.js-payment-sort-item')
          );
          const el = document.querySelector('.stmt-about-info__date__detail');
          let headerOk = false;
          if (el) {
            const text = (el.textContent || '')
              .replace(/\s*\([^)]*\)\s*$/, '')
              .trim();
            headerOk = /(\d{4})年(\d{1,2})月(\d{1,2})日/.test(text);
          }
          return { hasStatement, headerOk };
        }
      });
      const r = results?.[0]?.result;
      if (r?.hasStatement) {
        sawStatement = true;
      }
      if (r?.hasStatement && r?.headerOk) {
        return;
      }
    } catch (e) {
      /* 遷移直後は注入できないことがある */
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (sawStatement) {
    return;
  }
  throw new Error('楽天カード明細ページの表示が確認できませんでした（タイムアウト）');
}

/**
 * カレンダーで「次月」が無効になるまで進み、サイト上もっとも新しい明細月（以降分含む）を表示する。
 * 無効時は <span class="stmt-head-calendar__next stmt-head-calendar--desable"> になる。
 *
 * @param {number} tabId
 * @param {number} timeoutSec
 * @returns {Promise<void>}
 */
async function navigateRakutenStatementToLatestMonth(tabId, timeoutSec) {
  const maxSteps = 24;
  for (let step = 0; step < maxSteps; step++) {
    await activateRakutenStatementTab(tabId);
    await waitForRakutenStatementDom(tabId, timeoutSec);
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const nextEl = document.querySelector('.stmt-head-calendar__next');
        if (!nextEl) {
          return { atLatest: true, href: null };
        }
        const desabled =
          nextEl.classList.contains('stmt-head-calendar--desable') ||
          nextEl.classList.contains('stmt-head-calendar--disable');
        if (desabled) {
          return { atLatest: true, href: null };
        }
        if (nextEl.tagName !== 'A') {
          return { atLatest: true, href: null };
        }
        const href = nextEl.getAttribute('href');
        if (!href) {
          return { atLatest: true, href: null };
        }
        return { atLatest: false, href };
      }
    });
    const p = probe?.result;
    if (!p || p.atLatest) {
      return;
    }
    const tab = await chrome.tabs.get(tabId);
    const pageUrl = tab.url || '';
    const fullUrl = new URL(p.href, pageUrl).href;
    await chrome.tabs.update(tabId, { url: fullUrl });
    await waitForTabComplete(tabId, timeoutSec);
  }
  throw new Error('楽天カード明細の最新月への移動がタイムアウトしました');
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAccountLoginHostUrl(href) {
  if (!href) return false;
  try {
    const h = new URL(href).hostname;
    return h === 'login.account.rakuten.com' || h === 'eu.login.account.rakuten.com';
  } catch (e) {
    return false;
  }
}

/**
 * OAuth のリダイレクトで login.account から離れるまで待つ（すぐ tabs.update するとセッション未確定で再ログインになることがある）。
 *
 * @param {number} tabId
 * @param {number} timeoutSec
 * @returns {Promise<void>}
 */
async function waitForTabLeaveLoginHost(tabId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId);
    const u = t.url || '';
    if (u && !u.startsWith('chrome://') && !isAccountLoginHostUrl(u)) {
      return;
    }
    await sleepMs(200);
  }
  throw new Error('ログイン後のリダイレクトが完了しませんでした（ログイン画面のまま）');
}

/**
 * @param {string} currentUrl
 * @param {string} siteUrl
 * @returns {boolean}
 */
function shouldNavigateToSiteUrl(currentUrl, siteUrl) {
  try {
    const c = new URL(currentUrl);
    const s = new URL(siteUrl);
    const norm = (p) => p.replace(/\/$/, '') || '/';
    return c.origin !== s.origin || norm(c.pathname) !== norm(s.pathname);
  } catch (e) {
    return true;
  }
}

/** ログイン直後の Cookie / セッション確定待ち（ms） */
const RAKUTEN_POST_LOGIN_SETTLE_MS = 2500;

/** 前月へ遡る最大回数（無限ループ防止の上限） */
const RC_MAX_MONTHS_BACKWARD = 60;

/**
 * 楽天カード明細を household-statement-import へ送信する
 *
 * @param {string} siteId - サイトID（ログ用）
 * @param {Object} site - householdApiUrl, householdApiKey 必須（localMode 時は householdApiKeyLocal があればそちらを Bearer に使う）
 * @param {Array<Object>} items - 送信する明細
 * @param {boolean} mockMode
 * @param {boolean} localMode
 * @throws {Error}
 */
async function sendRakutenCardHouseholdImport(siteId, site, items, mockMode, localMode) {
  const apiUrl = (site.householdApiUrl || '').trim();
  const apiKey = localMode && (site.householdApiKeyLocal || '').trim()
    ? (site.householdApiKeyLocal || '').trim()
    : (site.householdApiKey || '');

  if (mockMode) {
    let logUrl = apiUrl || '(未設定)';
    if (apiUrl && localMode) {
      logUrl = resolveLocalApiUrl(apiUrl);
    }
    appendOptionsApiRequestLog({
      siteId,
      url: logUrl,
      mockMode: true,
      localMode,
      body: { items }
    }).catch(() => {});
    console.log(`${LOG_PREFIX} [モック] ${siteId} household POST ${apiUrl || '(未設定)'} 件数=${items?.length ?? 0}`);
    return;
  }

  if (!apiUrl) {
    throw new Error('Household API URLが設定されていません。オプション画面で設定してください。');
  }
  if (!apiKey) {
    throw new Error('Household API Keyが設定されていません。オプション画面で設定してください。');
  }
  if (!isValidApiUrl(apiUrl)) {
    throw new Error(`Invalid Household API URL format: ${apiUrl}`);
  }
  let postUrl = apiUrl;
  if (localMode) {
    postUrl = resolveLocalApiUrl(apiUrl);
  }
  appendOptionsApiRequestLog({
    siteId,
    url: postUrl,
    mockMode: false,
    localMode,
    body: { items }
  }).catch(() => {});
  const response = await fetch(postUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ items })
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'レスポンス取得失敗');
    if (response.status === 401) {
      throw new Error(`認証エラー: Household API Keyが無効です (${response.status})`);
    }
    if (response.status === 400) {
      throw new Error(`リクエストエラー: ${errorText} (${response.status})`);
    }
    throw new Error(`Household APIエラー: ${errorText} (${response.status})`);
  }
}

/**
 * @param {number} tabId
 * @param {number} timeoutSec
 * @returns {{ promise: Promise<{ didLogin: boolean }>, cancel: (reason?: Error) => void }}
 */
function createRakutenLoginWait(tabId, timeoutSec) {
  let resolved = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeoutId;
  /** @type {((message: unknown, sender: chrome.runtime.MessageSender) => void) | undefined} */
  let listener;
  /** @type {((reason?: unknown) => void) | undefined} */
  let rejectOuter;

  const promise = new Promise((resolve, reject) => {
    rejectOuter = reject;

    timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (listener) chrome.runtime.onMessage.removeListener(listener);
        reject(new Error('RAKUTEN_LOGIN_RESULT timeout'));
      }
    }, timeoutSec * 1000);

    listener = (message, sender) => {
      if (!message || typeof message !== 'object' || message.type !== 'RAKUTEN_LOGIN_RESULT') return;
      if (sender.tab?.id !== tabId) return;
      if (resolved) return;
      resolved = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      chrome.runtime.onMessage.removeListener(listener);
      if (message.error) {
        reject(new Error(message.error));
      } else {
        resolve({ didLogin: !!message.didLogin });
      }
    };

    chrome.runtime.onMessage.addListener(listener);
  });

  const cancel = (reason) => {
    if (resolved) return;
    resolved = true;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (listener) chrome.runtime.onMessage.removeListener(listener);
    if (rejectOuter) {
      rejectOuter(reason || new Error('ログイン処理スクリプトの注入に失敗しました'));
    }
  };

  return { promise, cancel };
}

/**
 * @param {number} tabId
 * @param {string} siteId
 * @param {Object} site
 * @param {boolean} mockMode
 * @param {boolean} localMode
 * @returns {Promise<Object>}
 */
function collectRakutenCardPage(tabId, siteId, site, mockMode, localMode) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        chrome.runtime.onMessage.removeListener(messageListener);
      }
    };

    const messageListener = (message, sender, sendResponse) => {
      if (sender.tab?.id === tabId && message.type === 'COLLECT_RESULT' && !resolved) {
        cleanup();
        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve(message.payload);
        }
        return true;
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);

    // ページ遷移のたびに注入コンテキストは消えるため、常に両方注入する。
    // （前月リンクや「今月」合わせの tabs.update 後は content-script なしだと sendMessage が届かない）
    const files = ['sites/rakuten-card.js', 'content-script.js'];

    chrome.scripting.executeScript({
      target: { tabId },
      files: files
    }).then(() => {
      let retries = 0;
      const maxRetries = 40;
      const trySendMessage = () => {
        chrome.tabs.sendMessage(tabId, { type: 'COLLECT', siteId, mockMode, localMode })
          .then((response) => {
            if (response && response.type === 'COLLECT_RESULT' && !resolved) {
              cleanup();
              if (response.error) {
                reject(new Error(response.error));
              } else {
                resolve(response.payload);
              }
            }
          })
          .catch((err) => {
            if (retries < maxRetries && !resolved) {
              retries++;
              setTimeout(trySendMessage, 100);
            } else {
              cleanup();
              reject(new Error(`Failed to send message to content script: ${err.message}`));
            }
          });
      };
      setTimeout(trySendMessage, 100);
    }).catch((err) => {
      cleanup();
      reject(new Error(`Failed to inject content script: ${err.message}`));
    });

    setTimeout(() => {
      if (!resolved) {
        cleanup();
        reject(new Error('Content script timeout'));
      }
    }, Math.max(0, (site.timeoutSec - 5) * 1000));
  });
}

/**
 * @param {Object} site
 * @param {string} siteId
 * @param {number} tabId
 * @param {boolean} mockMode
 * @param {boolean} localMode
 * @returns {Promise<Object>}
 */
async function runRakutenCardFlow(site, siteId, tabId, mockMode, localMode) {
  await activateRakutenStatementTab(tabId);
  const { promise: loginPromise, cancel: cancelLoginWait } = createRakutenLoginWait(
    tabId,
    site.timeoutSec
  );
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['sites/rakuten-card-login-exec.js']
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    cancelLoginWait(e);
    await loginPromise.catch(() => {});
    throw e;
  }
  const loginResult = await loginPromise;
  if (loginResult.didLogin) {
    await waitForTabComplete(tabId, site.timeoutSec);
    await waitForTabLeaveLoginHost(tabId, site.timeoutSec);
    await sleepMs(RAKUTEN_POST_LOGIN_SETTLE_MS);
    const siteUrl = (site.url || '').trim();
    if (siteUrl) {
      const tab = await chrome.tabs.get(tabId);
      const cur = tab.url || '';
      if (shouldNavigateToSiteUrl(cur, siteUrl)) {
        await chrome.tabs.update(tabId, { url: siteUrl });
        await waitForTabComplete(tabId, site.timeoutSec);
      }
    }
  }

  await waitForRakutenStatementDom(tabId, site.timeoutSec);
  await navigateRakutenStatementToLatestMonth(tabId, site.timeoutSec);

  const rcMonthsRaw = site?.rcMonthsToFetch;
  const rcMonthsToFetch = (rcMonthsRaw !== '' && rcMonthsRaw != null)
    ? Math.max(1, Math.min(60, parseInt(String(rcMonthsRaw), 10) || 2))
    : 2;
  const rcMinRaw = (site?.rcMinYearMonth || '').trim();
  const rcMinYearMonth = /^\d{4}-\d{2}$/.test(rcMinRaw) ? rcMinRaw : '2026-03';

  const allItems = [];
  let lastPayload = null;
  /** @type {Array<{ level: string, text: string, at: number }>} */
  const mergedCollectLogs = [];

  for (let i = 0; i < Math.min(RC_MAX_MONTHS_BACKWARD, rcMonthsToFetch); i++) {
    await activateRakutenStatementTab(tabId);
    await waitForRakutenStatementDom(tabId, site.timeoutSec);
    const pagePayload = await collectRakutenCardPage(tabId, siteId, site, mockMode, localMode);
    lastPayload = pagePayload;
    if (pagePayload.collectLogs?.length) {
      mergedCollectLogs.push(...pagePayload.collectLogs);
    }
    const inner = pagePayload.payload;
    if (inner.items && inner.items.length) {
      for (const it of inner.items) {
        allItems.push(it);
      }
    }
    const dym = inner.displayedYearMonth;
    if (dym == null || dym < rcMinYearMonth) {
      break;
    }
    if (!inner.prevMonthHref) {
      break;
    }
    const fullUrl = new URL(inner.prevMonthHref, pagePayload.url).href;
    await chrome.tabs.update(tabId, { url: fullUrl });
    await waitForTabComplete(tabId, site.timeoutSec);
  }

  return {
    siteId,
    url: lastPayload ? lastPayload.url : '',
    capturedAt: Date.now(),
    payload: { items: allItems },
    collectLogs: mergedCollectLogs
  };
}

/**
 * MoneyForward の batches を IFA API へ送信する
 * （Content Script では CORS で fetch できないため Service Worker で実行）
 *
 * @param {string} siteId - サイトID（ログ用）
 * @param {Object} site - サイト設定（ifaApiUrl, ifaApiKey 必須。localMode 時は ifaApiKeyLocal があればそちらを Bearer に使う）
 * @param {Array<{instrument: Object, items: Array}>} batches - 送信するバッチ配列
 * @param {boolean} mockMode - true の場合は fetch せず console.log のみ
 * @param {boolean} localMode
 * @throws {Error} 設定不足または API エラー時
 */
async function sendMoneyforwardBatches(siteId, site, batches, mockMode, localMode) {
  const apiUrl = (site.ifaApiUrl || '').trim();
  const apiKey = localMode && (site.ifaApiKeyLocal || '').trim()
    ? (site.ifaApiKeyLocal || '').trim()
    : (site.ifaApiKey || '');
  if (!apiUrl) {
    throw new Error('IFA API URLが設定されていません。オプション画面で設定してください。');
  }
  if (!apiKey) {
    throw new Error('IFA API Keyが設定されていません。オプション画面で設定してください。');
  }
  if (!isValidApiUrl(apiUrl)) {
    throw new Error(`Invalid IFA API URL format: ${apiUrl}`);
  }
  let postUrl = apiUrl;
  if (localMode) {
    postUrl = resolveLocalApiUrl(apiUrl);
  }
  if (mockMode) {
    const totalItems = batches?.reduce((sum, b) => sum + (b?.items?.length ?? 0), 0) ?? 0;
    for (const batch of batches) {
      appendOptionsApiRequestLog({
        siteId,
        url: postUrl,
        mockMode: true,
        localMode,
        body: batch
      }).catch(() => {});
    }
    console.log(`${LOG_PREFIX} [モック] ${siteId} IFA POST バッチ=${batches?.length ?? 0} 件数=${totalItems}`);
    return;
  }
  for (const batch of batches) {
    appendOptionsApiRequestLog({
      siteId,
      url: postUrl,
      mockMode: false,
      localMode,
      body: batch
    }).catch(() => {});
    const response = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(batch)
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'レスポンス取得失敗');
      if (response.status === 401) {
        throw new Error(`認証エラー: IFA API Keyが無効です (${response.status})`);
      }
      if (response.status === 400) {
        throw new Error(`リクエストエラー: ${errorText} (${response.status})`);
      }
      throw new Error(`IFA APIエラー: ${errorText} (${response.status})`);
    }
    const result = await response.json();
    if (result?.result === 'partial') {
      console.warn('IFA API: 部分的に処理されました', result);
    }
  }
}

/**
 * 巡回結果ペイロードから記録件数を算出する（既知の siteId の形のみ）
 * ログ用・Slack 補足用。形が分からないサイトは null。
 *
 * @param {string} siteId
 * @param {Object} [payload] - collect の戻り（payload.payload に各サイト固有データ）
 * @returns {number|null}
 */
function getPayloadRecordCount(siteId, payload) {
  const p = payload?.payload;
  if (!p) return null;
  if (siteId === 'moneyforward' && Array.isArray(p.batches)) {
    return p.batches.reduce((s, b) => s + (b?.items?.length ?? 0), 0);
  }
  if (siteId === 'rakuten-card' && Array.isArray(p.items)) {
    return p.items.length;
  }
  if (siteId === 'x-bookmarks' && Array.isArray(p.tweets)) {
    return p.tweets.length;
  }
  return null;
}

/**
 * 1サイトの巡回処理を実行する
 * 
 * 設計書の「共通骨格」に従い、タブは毎回新規作成して処理後に必ず閉じる。
 * タブの再利用を避けることで、前回の状態が残るバグを防止している。
 * 
 * 処理フロー:
 * 1. タブ作成（非アクティブで開く）
 * 2. 読み込み完了待機（timeoutSecで打ち切り）
 * 3. Content Script注入とデータ抽出
 * 4. API送信（Service Workerが実施、またはcontent-script側で実施）
 * 5. state更新（成功/失敗に応じて）
 * 6. タブクローズ（finallyで確実に実行）
 * 
 * @param {string} siteId - 処理対象のサイトID
 * @param {Object} options - 実行オプション
 * @param {'schedule'|'manual'} [options.invokedBy] - 起動経路（省略時は 'schedule'）
 * @param {boolean} options.mockMode - モックモード（trueの場合、fetchを実行せずconsole.logで出力）
 * @param {boolean} [options.localMode] - ローカル手動実行（true のとき mockMode は無視され false 扱い）
 */
async function runSite(siteId, options = {}) {
  const invokedBy = options.invokedBy === 'manual' ? 'manual' : 'schedule';
  const localMode = options.localMode === true;
  const mockMode = localMode ? false : (options.mockMode === true);
  const { settings } = await chrome.storage.local.get('settings');
  const site = settings.sites[siteId];
  if (!site) {
    console.warn(`${LOG_PREFIX} ${siteId} 失敗: 設定にサイトが存在しません`);
    // 設定不整合をエラーとして扱い、次回リトライをスケジュール
    const now = Date.now();
    const currentState = await chrome.storage.local.get('state');
    const currentSiteState = currentState.state.bySite[siteId] || {};
    currentState.state.bySite[siteId] = {
      nextRun: computeNextRunAfterFail(now),
      lastStatus: 'fail',
      failCount: (currentSiteState.failCount || 0) + 1,
      lastRun: now,
      lastError: 'Site not found in settings'
    };
    await chrome.storage.local.set({ state: currentState.state });
    return;
  }

  const meta = formatSiteLogMeta(siteId, invokedBy, mockMode, localMode);
  const now = Date.now();
  let tabId = null;

  try {
    // URL検証を try 内で実行（catch で捕捉するため）
    const siteUrl = site.url || '';
    if (siteUrl.startsWith('chrome-extension://') ||
        siteUrl.startsWith('chrome://') ||
        siteUrl.startsWith('edge://') ||
        siteUrl.startsWith('about:') ||
        siteUrl.startsWith('data:') ||
        siteUrl.startsWith('javascript:')) {
      throw new Error(`Invalid URL for content script injection: ${siteUrl}. Please use a valid HTTP/HTTPS URL.`);
    }

    console.log(`${meta} 開始`);
    const tab = await chrome.tabs.create({
      url: site.url,
      active: siteId === 'rakuten-card'
    });
    tabId = tab.id;
    
    await waitForTabComplete(tabId, site.timeoutSec);
    
    // タブのURLを確認し、コンテンツスクリプトを注入可能かチェック
    const currentTab = await chrome.tabs.get(tabId);
    const tabUrl = currentTab.url || '';
    
    // 拡張機能URLやその他の許可されていないURLを除外
    if (tabUrl.startsWith('chrome-extension://') || 
        tabUrl.startsWith('chrome://') || 
        tabUrl.startsWith('edge://') ||
        tabUrl.startsWith('about:') ||
        tabUrl.startsWith('data:') ||
        tabUrl.startsWith('javascript:')) {
      throw new Error(`Cannot inject content script into restricted URL: ${tabUrl}`);
    }
    
    // Content Script注入とメッセージ送信は非同期に実行されるため、
    // リスナーを先に登録してから注入・送信を行う
    let payload;
    if (siteId === 'rakuten-card') {
      payload = await runRakutenCardFlow(site, siteId, tabId, mockMode, localMode);
    } else {
      payload = await new Promise((resolve, reject) => {
      let resolved = false;
      
      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(messageListener);
        }
      };
      
      const messageListener = (message, sender, sendResponse) => {
        if (sender.tab?.id === tabId && message.type === 'COLLECT_RESULT' && !resolved) {
          cleanup();
          if (message.error) {
            // #region agent log
            fetch('http://127.0.0.1:7246/ingest/5589c68a-9b2d-4dd1-b897-9a40c75ce2d9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8ad54d'},body:JSON.stringify({sessionId:'8ad54d',location:'service-worker.js:messageListener',message:'COLLECT_RESULT error via onMessage',data:{error:message.error,siteId},timestamp:Date.now(),hypothesisId:'C'})}).catch(()=>{});
            // #endregion
            reject(new Error(message.error));
          } else {
            resolve(message.payload);
          }
          return true;
        }
      };
      
      chrome.runtime.onMessage.addListener(messageListener);
      
      const scriptPath = 'sites/' + siteId.replace(/_/g, '-') + '.js';
      const files = [scriptPath, 'content-script.js'];
      
      chrome.scripting.executeScript({
        target: { tabId },
        files: files
      }).then(() => {
        // Content ScriptのonMessageリスナーが登録されるまでの時間差を考慮し、
        // 再試行ロジックで確実にメッセージを送信する
        let retries = 0;
        const maxRetries = 5;
        const trySendMessage = () => {
          chrome.tabs.sendMessage(tabId, { type: 'COLLECT', siteId, mockMode, localMode })
            .then((response) => {
              // chrome.tabs.sendMessageのPromiseがresolveした場合、responseが返ってくる
              // この場合、messageListenerは呼ばれないため、ここで処理する
              if (response && response.type === 'COLLECT_RESULT' && !resolved) {
                cleanup();
                if (response.error) {
                  // #region agent log
                  fetch('http://127.0.0.1:7246/ingest/5589c68a-9b2d-4dd1-b897-9a40c75ce2d9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8ad54d'},body:JSON.stringify({sessionId:'8ad54d',location:'service-worker.js:trySendMessage',message:'COLLECT_RESULT error via sendResponse',data:{error:response.error,siteId},timestamp:Date.now(),hypothesisId:'C'})}).catch(()=>{});
                  // #endregion
                  reject(new Error(response.error));
                } else {
                  resolve(response.payload);
                }
              }
              // responseがundefinedまたはCOLLECT_RESULTでない場合、messageListenerで処理される
            })
            .catch((err) => {
              if (retries < maxRetries && !resolved) {
                retries++;
                setTimeout(trySendMessage, 50);
              } else {
                cleanup();
                reject(new Error(`Failed to send message to content script: ${err.message}`));
              }
            });
        };
        setTimeout(trySendMessage, 50);
      }).catch((err) => {
        cleanup();
        reject(new Error(`Failed to inject content script: ${err.message}`));
      });
      
      // タイムアウトはsite.timeoutSecより5秒短く設定
      // （タブ読み込み待機時間を考慮し、全体のタイムアウトを超えないようにする）
      // timeoutSec が 5 以下の場合は 0 にし、負数になる問題を防ぐ
      setTimeout(() => {
        if (!resolved) {
          cleanup();
          reject(new Error('Content script timeout'));
        }
      }, Math.max(0, (site.timeoutSec - 5) * 1000));
    });
    }

    emitCollectLogsAndStrip(siteId, payload);

    // site.apiUrl が存在する場合、Service Worker が送信を担当
    if (site.apiUrl && site.apiUrl.trim()) {
      const apiUrl = site.apiUrl.trim();
      
      // SSRF対策: プロトコルをhttp/httpsに制限
      if (!isValidApiUrl(apiUrl)) {
        throw new Error(`Invalid API URL format: ${apiUrl}`);
      }
      
      if (mockMode) {
        console.log(`${LOG_PREFIX} [モック] ${siteId} 汎用API POST ${apiUrl}`);
      } else {
        let postUrl = apiUrl;
        if (localMode) {
          postUrl = resolveLocalApiUrl(apiUrl);
        }
        const response = await fetch(postUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
          throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }
      }
    }
    // moneyforward: payload.batches を ifaApiUrl へ送信（Content Script では CORS で fetch できないため）
    else if (siteId === 'moneyforward' && payload?.payload?.batches?.length) {
      await sendMoneyforwardBatches(siteId, site, payload.payload.batches, mockMode, localMode);
    }
    // rakuten-card: household-statement-import へ items を送信
    else if (siteId === 'rakuten-card' && payload?.payload?.items?.length) {
      await sendRakutenCardHouseholdImport(siteId, site, payload.payload.items, mockMode, localMode);
    }
    
    const currentState = await chrome.storage.local.get('state');
    currentState.state.bySite[siteId] = {
      nextRun: computeNextRunAfterSuccess(now, site.schedule),
      lastStatus: 'ok',
      failCount: 0,
      lastRun: now
    };
    await chrome.storage.local.set({ state: currentState.state });

    const recordCount = getPayloadRecordCount(siteId, payload);
    const countSummary = recordCount === null ? '' : ` ${recordCount}件`;
    console.log(`${meta} 成功${countSummary}`);

    if (settings?.slackWebhookUrl && recordCount === 0) {
      await notifySlackOnZeroItems(settings.slackWebhookUrl, { siteId });
    }

    // エラー用 Webhook とは別チャンネルへ稼働確認（heartbeat）通知（モック実行は除く・URL 未設定なら送らない）
    if (!mockMode && settings?.slackSuccessWebhookUrl?.trim()) {
      const runLabel = `${invokedBy === 'manual' ? '手動' : 'スケジュール'} / ${localMode ? 'ローカル' : '通常'}`;
      await notifySlackOnSuccess(settings.slackSuccessWebhookUrl, {
        siteId,
        recordCount,
        runLabel,
      });
    }

  } catch (error) {
    console.warn(`${meta} 失敗:`, error.message || String(error));
    
    const currentState = await chrome.storage.local.get('state');
    const currentSiteState = currentState.state.bySite[siteId] || {};
    
    // エラーメッセージに機密情報（APIキー等）が含まれる可能性があるため、
    // 保存前にサニタイズしてから100文字に制限
    let errorMessage = error.message || String(error);
    errorMessage = errorMessage.replace(/password|token|secret|key|api[_-]?key/gi, '[REDACTED]');
    errorMessage = errorMessage.substring(0, 100);
    
    const failCount = (currentSiteState.failCount || 0) + 1;
    
    currentState.state.bySite[siteId] = {
      nextRun: computeNextRunAfterFail(now),
      lastStatus: 'fail',
      failCount: failCount,
      lastRun: now,
      lastError: errorMessage
    };
    await chrome.storage.local.set({ state: currentState.state });
    
    // Slack 通知（設定されていれば）
    if (settings?.slackWebhookUrl) {
      await notifySlackOnFailure(settings.slackWebhookUrl, {
        siteId,
        error: errorMessage,
        failCount
      });
    }
  } finally {
    // タブは必ず閉じる（finallyで確実に実行）
    // タブが既に閉じられている場合のエラーは無視
    if (tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        console.warn(`Failed to close tab ${tabId}:`, e);
      }
    }
  }
}

/**
 * アラーム起床時の処理
 * 
 * 1時間ごとに呼ばれ、各サイトのnextRunと現在時刻を比較して
 * 実行すべきサイトだけを処理する。
 * 
 * 実行順序はsiteId昇順で固定（再現性と単純さを優先）。
 * 並列実行はしない（運用安定性を優先）。
 * 
 * 設計書の「not-before」方式に従い、now >= nextRunのサイトを実行する。
 * PCスリープ等で遅れても、次回起床で実行可能になる。
 */
async function onAlarm() {
  console.log(`${LOG_PREFIX} スケジュールチェック開始`);

  const { settings, state } = await initializeStorage();
  const now = Date.now();

  // 実行順序を固定するため、siteIdでソート
  const allSiteIds = Object.keys(settings.sites).sort();
  const toRun = [];
  for (const siteId of allSiteIds) {
    const site = settings.sites[siteId];
    const siteState = state.bySite[siteId];
    if (!site?.enabled) continue;
    if (siteState && siteState.nextRun > now) continue;
    toRun.push(siteId);
  }

  console.log(`${LOG_PREFIX} 実行対象: ${toRun.length ? toRun.join(', ') : '該当なし'}`);

  for (const siteId of toRun) {
    await runSite(siteId);
  }
}

// インストール時: 初回セットアップとアラーム設定
// 初回インストール時のみ、初期化完了後に初回実行を行う
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('Extension installed, initializing...');
  await initializeStorage();
  
  chrome.alarms.create('hourly-check', {
    periodInMinutes: 60
  });
  
  console.log('Alarm set for hourly checks');
  
  // 初回インストール時のみ実行（update時は不要）
  // 初期化が完了するまで少し待つ
  if (details.reason === 'install') {
    setTimeout(() => {
      onAlarm();
    }, 2000);
  }
});

// ブラウザ起動時: Service Workerが再起動された場合の復旧処理
// アラームは永続化されるが、念のため存在確認を行う
chrome.runtime.onStartup.addListener(async () => {
  console.log('Extension started, initializing...');
  await initializeStorage();
  
  const alarms = await chrome.alarms.getAll();
  if (!alarms.find(a => a.name === 'hourly-check')) {
    chrome.alarms.create('hourly-check', {
      periodInMinutes: 60
    });
  }
});

// アラームイベント: 1時間ごとに起床
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'hourly-check') {
    onAlarm();
  }
});

// Content Script からのモックログメッセージを受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'MOCK_LOG') {
    const msg = message.message != null ? String(message.message) : '';
    const data = message.data != null ? message.data : {};
    console.log(`${LOG_PREFIX} [モック] ${msg}`, data);
    return false;
  }
  if (message.type === 'DEBUG_LOG') {
    fetch('http://127.0.0.1:7246/ingest/5589c68a-9b2d-4dd1-b897-9a40c75ce2d9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8ad54d'},body:JSON.stringify({...message.payload,timestamp:message.payload?.timestamp||Date.now()})}).catch(()=>{});
    return false;
  }
});

// オプション画面からの「今すぐ実行」メッセージを受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RUN_SITE') {
    (async () => {
      try {
        await runSite(message.siteId, {
          invokedBy: 'manual',
          mockMode: message.mockMode || false,
          localMode: message.localMode === true
        });
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // 非同期応答を保持
  }
});

