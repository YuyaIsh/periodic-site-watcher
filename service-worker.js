/**
 * 成功時の次回実行時刻を計算する
 * 
 * 設計書の「not-before」方式に従い、指定されたスケジュールに基づいて
 * 「この時刻以降なら実行してよい」という時刻を返す。
 * PCスリープ等で遅れても、次回起床で実行可能になるように設計されている。
 * 
 * @param {number} now - 現在時刻（epoch ms）
 * @param {Object} schedule - スケジュール設定
 * @param {string} schedule.type - 'hourly' | 'daily' | 'weekly'
 * @param {number} [schedule.minute] - hourlyの場合の分（0-59）
 * @param {string} [schedule.at] - daily/weeklyの場合の時刻（'HH:MM'）
 * @param {number} [schedule.dow] - weeklyの場合の曜日（0=日曜）
 * @returns {number} 次回実行時刻（epoch ms）
 */
function computeNextRunAfterSuccess(now, schedule) {
  const date = new Date(now);
  
  if (schedule.type === 'hourly') {
    date.setMinutes(schedule.minute, 0, 0);
    // 既に過ぎている場合は次時間に回す（毎時同じ分に実行するため）
    if (date.getTime() <= now) {
      date.setHours(date.getHours() + 1);
    }
    return date.getTime();
  } else if (schedule.type === 'daily') {
    const [hours, minutes] = schedule.at.split(':').map(Number);
    date.setHours(hours, minutes, 0, 0);
    // 今日の時刻を過ぎている場合は翌日に設定
    if (date.getTime() <= now) {
      date.setDate(date.getDate() + 1);
    }
    return date.getTime();
  } else if (schedule.type === 'weekly') {
    const [hours, minutes] = schedule.at.split(':').map(Number);
    const currentDay = date.getDay();
    const targetDay = schedule.dow;
    // 今週の該当日までの日数を計算（負の値にならないよう+7してから%7）
    let daysToAdd = (targetDay - currentDay + 7) % 7;
    
    date.setHours(hours, minutes, 0, 0);
    // 今日が該当日だが時刻を過ぎている場合は来週に設定
    if (daysToAdd === 0 && date.getTime() <= now) {
      daysToAdd = 7;
    }
    date.setDate(date.getDate() + daysToAdd);
    return date.getTime();
  }
  
  // 未知のスケジュールタイプの場合は1時間後を返す（フォールバック）
  return now + 60 * 60 * 1000;
}

/**
 * 失敗時の次回実行時刻を計算する
 * 
 * 設計書に従い、失敗時は常に1時間後に再試行する。
 * retryに分単位設定を持たないことで、誤解と複雑化を避けている。
 * 
 * @param {number} now - 現在時刻（epoch ms）
 * @returns {number} 次回実行時刻（now + 1時間）
 */
function computeNextRunAfterFail(now) {
  return now + 60 * 60 * 1000;
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
 * 1サイトの巡回処理を実行する
 * 
 * 設計書の「共通骨格」に従い、タブは毎回新規作成して処理後に必ず閉じる。
 * タブの再利用を避けることで、前回の状態が残るバグを防止している。
 * 
 * 処理フロー:
 * 1. タブ作成（非アクティブで開く）
 * 2. 読み込み完了待機（timeoutSecで打ち切り）
 * 3. Content Script注入とデータ抽出
 * 4. API送信（Service Workerが実施）
 * 5. state更新（成功/失敗に応じて）
 * 6. タブクローズ（finallyで確実に実行）
 * 
 * @param {string} siteId - 処理対象のサイトID
 */
async function runSite(siteId) {
  const { settings, _ } = await chrome.storage.local.get(['settings', 'state']);
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
      chrome.tabs.get(tabId).then(tab => {
        if (tab.status === 'complete' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }).catch(() => {
        // タブが既に閉じられている場合は無視（タイムアウトで処理される）
      });
    });
    
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
            reject(new Error(message.error));
          } else {
            resolve(message.payload);
          }
          return true;
        }
      };
      
      chrome.runtime.onMessage.addListener(messageListener);
      
      chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-script.js']
      }).then(() => {
        // Content ScriptのonMessageリスナーが登録されるまでの時間差を考慮し、
        // 再試行ロジックで確実にメッセージを送信する
        let retries = 0;
        const maxRetries = 5;
        const trySendMessage = () => {
          chrome.tabs.sendMessage(tabId, { type: 'COLLECT', siteId })
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
      setTimeout(() => {
        if (!resolved) {
          cleanup();
          reject(new Error('Content script timeout'));
        }
      }, (site.timeoutSec - 5) * 1000);
    });
    
    const apiUrl = settings.apiUrl || 'http://localhost:3000/collect';
    
    // SSRF対策: プロトコルをhttp/httpsに制限
    // 内部ネットワーク（file://, ftp://等）へのアクセスを防止
    try {
      const parsedUrl = new URL(apiUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('Invalid API URL protocol');
      }
    } catch (error) {
      throw new Error(`Invalid API URL format: ${apiUrl}`);
    }
    
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
    
    currentState.state.bySite[siteId] = {
      nextRun: computeNextRunAfterFail(now),
      lastStatus: 'fail',
      failCount: (currentSiteState.failCount || 0) + 1,
      lastRun: now,
      lastError: errorMessage
    };
    await chrome.storage.local.set({ state: currentState.state });
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

