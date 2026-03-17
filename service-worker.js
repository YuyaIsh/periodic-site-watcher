// 共通ユーティリティを読み込む（Service WorkerではimportScriptsを使用）
importScripts('utils/schedule.js', 'utils/validation.js', 'utils/slack.js');

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
 * MoneyForward の batches を IFA API へ送信する
 * （Content Script では CORS で fetch できないため Service Worker で実行）
 *
 * @param {Object} site - サイト設定（ifaApiUrl, ifaApiKey 必須）
 * @param {Array<{instrument: Object, items: Array}>} batches - 送信するバッチ配列
 * @param {boolean} mockMode - true の場合は fetch せず console.log のみ
 * @throws {Error} 設定不足または API エラー時
 */
async function sendMoneyforwardBatches(site, batches, mockMode) {
  const apiUrl = (site.ifaApiUrl || '').trim();
  const apiKey = site.ifaApiKey || '';
  if (!apiUrl) {
    throw new Error('IFA API URLが設定されていません。オプション画面で設定してください。');
  }
  if (!apiKey) {
    throw new Error('IFA API Keyが設定されていません。オプション画面で設定してください。');
  }
  if (!isValidApiUrl(apiUrl)) {
    throw new Error(`Invalid IFA API URL format: ${apiUrl}`);
  }
  if (mockMode) {
    for (const batch of batches) {
      console.log('[Mock] Would POST to', apiUrl, batch);
    }
    return;
  }
  for (const batch of batches) {
    const response = await fetch(apiUrl, {
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
 * @param {boolean} options.mockMode - モックモード（trueの場合、fetchを実行せずconsole.logで出力）
 */
async function runSite(siteId, options = {}) {
  const { mockMode = false } = options;
  const { settings } = await chrome.storage.local.get('settings');
  const site = settings.sites[siteId];
  if (!site) {
    console.error(`Site ${siteId} not found in settings`);
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
  
  const now = Date.now();
  let tabId = null;
  
  // URL検証をタブ作成前に実行（早期エラー検出）
  const siteUrl = site.url || '';
  if (siteUrl.startsWith('chrome-extension://') || 
      siteUrl.startsWith('chrome://') || 
      siteUrl.startsWith('edge://') ||
      siteUrl.startsWith('about:') ||
      siteUrl.startsWith('data:') ||
      siteUrl.startsWith('javascript:')) {
    throw new Error(`Invalid URL for content script injection: ${siteUrl}. Please use a valid HTTP/HTTPS URL.`);
  }
  
  try {
    const tab = await chrome.tabs.create({ url: site.url, active: false });
    tabId = tab.id;
    
    // tabs.onUpdatedとtabs.getの両方がresolveを呼ぶ可能性があるため、
    // フラグで重複解決を防止（Promiseの重複解決は未定義動作）
    await new Promise((resolve, reject) => {
      let resolved = false;
      
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error(`Timeout after ${site.timeoutSec} seconds`));
        }
      }, site.timeoutSec * 1000);
      
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      
      chrome.tabs.onUpdated.addListener(listener);
      
      // タブが既にcomplete状態の場合、onUpdatedが発火しないため
      // 明示的にチェックする必要がある
      chrome.tabs.get(tabId).then(tabInfo => {
        if (tabInfo.status === 'complete' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }).catch(() => {
        // タブが既に閉じられている場合は無視（タイムアウトで処理される）
      });
    });
    
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
    const payload = await new Promise((resolve, reject) => {
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
          chrome.tabs.sendMessage(tabId, { type: 'COLLECT', siteId, mockMode })
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
    
    // site.apiUrl が存在する場合、Service Worker が送信を担当
    if (site.apiUrl && site.apiUrl.trim()) {
      const apiUrl = site.apiUrl.trim();
      
      // SSRF対策: プロトコルをhttp/httpsに制限
      if (!isValidApiUrl(apiUrl)) {
        throw new Error(`Invalid API URL format: ${apiUrl}`);
      }
      
      if (mockMode) {
        console.log('[Mock] Would POST to', apiUrl, payload);
      } else {
        const response = await fetch(apiUrl, {
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
      await sendMoneyforwardBatches(site, payload.payload.batches, mockMode);
    }
    
    const currentState = await chrome.storage.local.get('state');
    currentState.state.bySite[siteId] = {
      nextRun: computeNextRunAfterSuccess(now, site.schedule),
      lastStatus: 'ok',
      failCount: 0,
      lastRun: now
    };
    await chrome.storage.local.set({ state: currentState.state });
    
    console.log(`Site ${siteId} processed successfully`);
    
  } catch (error) {
    console.error(`Error processing site ${siteId}:`, error);
    
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
  console.log('Alarm triggered, checking sites...');
  
  const { settings, state } = await initializeStorage();
  const now = Date.now();
  
  // 実行順序を固定するため、siteIdでソート
  const siteIds = Object.keys(settings.sites).sort();
  
  for (const siteId of siteIds) {
    const site = settings.sites[siteId];
    const siteState = state.bySite[siteId];
    
    if (!site.enabled) {
      continue;
    }
    
    // not-before方式: nextRunが未来なら実行しない
    if (siteState && siteState.nextRun > now) {
      continue;
    }
    
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
    console.log(message.message, message.data);
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
        await runSite(message.siteId, { mockMode: message.mockMode || false });
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // 非同期応答を保持
  }
});

