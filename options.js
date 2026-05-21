// Options Page: 設定編集、storage保存

// 共通ユーティリティを読み込む（HTMLからscriptタグで読み込まれる）
// utils/validation.js と utils/schedule.js が先に読み込まれている必要がある

/** Service Worker 側 utils/options-api-log.js と同じキー */
const OPTIONS_API_LOG_STORAGE_KEY = 'optionsApiRequestLog';

/**
 * オプション上部の API 送信ログ欄を更新する
 * @param {Array<unknown>|undefined} entries
 */
function renderOptionsApiLog(entries) {
  const el = document.getElementById('options-api-log');
  if (!el) {
    return;
  }
  if (!entries || entries.length === 0) {
    el.textContent =
      '（送信ログはまだありません。楽天カード／マネーフォワードの巡回で API 送信時にここへ追記されます。オプションを開いたままにすると自動更新されます。）';
    return;
  }
  const blocks = entries.slice().reverse().map((e) => {
    const row = typeof e === 'object' && e !== null ? { ...e } : { value: e };
    if (typeof row.at === 'number') {
      row.atLocal = new Date(row.at).toLocaleString('ja-JP', {
        dateStyle: 'medium',
        timeStyle: 'medium'
      });
    }
    return JSON.stringify(row, null, 2);
  });
  el.textContent = blocks.join('\n\n————————————————\n\n');
}

async function refreshOptionsApiLog() {
  const got = await chrome.storage.local.get(OPTIONS_API_LOG_STORAGE_KEY);
  renderOptionsApiLog(got[OPTIONS_API_LOG_STORAGE_KEY]);
}

/**
 * x-bookmarks の処理済みポスト一覧 HTML を生成する
 *
 * @param {Record<string, { processedAt?: number, conversationUrl?: string|null, title?: string|null }>} processedTweetIds
 * @returns {string}
 */
function renderProcessedTweetIdsTableHtml(processedTweetIds) {
  const entries = Object.entries(processedTweetIds || {});
  if (entries.length === 0) {
    return '<p class="processed-tweets-empty">処理済みポストはありません。</p>';
  }

  const rows = entries
    .sort(([, a], [, b]) => (b.processedAt || 0) - (a.processedAt || 0))
    .map(([tweetId, meta]) => {
      const processedAt = meta.processedAt
        ? new Date(meta.processedAt).toLocaleString('ja-JP')
        : '-';
      const title = escapeHtml(meta.title || '-');
      const conversationUrl = (meta.conversationUrl || '').trim();
      const chatgptCell = conversationUrl
        ? `<a href="${escapeHtml(conversationUrl)}" target="_blank" rel="noopener noreferrer">ChatGPT</a>`
        : '-';
      return `
        <tr>
          <td>${escapeHtml(tweetId)}</td>
          <td>${escapeHtml(processedAt)}</td>
          <td>${title}</td>
          <td>${chatgptCell}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <div class="processed-tweets-list">
      <table class="processed-tweets-table">
        <thead>
          <tr>
            <th>Tweet ID</th>
            <th>処理日時</th>
            <th>タイトル</th>
            <th>ChatGPT</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

/**
 * x-bookmarks サイトセクションに処理済みポスト一覧を追加する
 *
 * @param {HTMLElement} siteDiv
 * @param {string} siteId
 * @param {Record<string, unknown>} processedTweetIds
 */
function appendProcessedTweetIdsSection(siteDiv, siteId, processedTweetIds) {
  const body = siteDiv.querySelector('.site-accordion-body');
  if (!body) return;

  const section = document.createElement('div');
  section.className = 'processed-tweets-section';
  section.innerHTML = `
    <h3>処理済みポスト</h3>
    <div class="processed-tweets-toolbar">
      <span class="processed-tweets-empty">${Object.keys(processedTweetIds || {}).length} 件</span>
      <button type="button" class="delete reset-processed-tweets" data-site-id="${escapeHtml(siteId)}">All Reset</button>
    </div>
    ${renderProcessedTweetIdsTableHtml(processedTweetIds)}
  `;

  const stateDisplay = body.querySelector('.state-display');
  if (stateDisplay) {
    stateDisplay.insertAdjacentElement('afterend', section);
  } else {
    body.appendChild(section);
  }

  const resetButton = section.querySelector('.reset-processed-tweets');
  if (resetButton) {
    resetButton.addEventListener('click', async (e) => {
      e.stopPropagation();
      await resetAllProcessedTweetIds(siteId);
    });
  }
}

/**
 * 処理済みポストをすべてリセットする
 *
 * @param {string} siteId
 */
async function resetAllProcessedTweetIds(siteId) {
  const confirmed = confirm(
    '処理済みポストをすべてリセットします。次回実行時に再処理されます。よろしいですか？'
  );
  if (!confirmed) return;

  const result = await chrome.storage.local.get('state');
  const state = result.state || { bySite: {} };
  if (!state.bySite) state.bySite = {};
  if (!state.bySite[siteId]) {
    state.bySite[siteId] = {};
  }
  state.bySite[siteId].processedTweetIds = {};
  await chrome.storage.local.set({ state });
  await loadSites();
}

async function clearOptionsApiLog() {
  if (!confirm('API 送信ログをすべて消去しますか？')) {
    return;
  }
  await chrome.storage.local.set({ [OPTIONS_API_LOG_STORAGE_KEY]: [] });
  await refreshOptionsApiLog();
}

/**
 * 指定 siteId の sites/${siteId}.options.js を動的ロードする
 *
 * @param {string} siteId - サイトID
 * @returns {Promise<void>} ロード完了（404の場合は onerror で resolve）
 */
function loadSiteOptionsScript(siteId) {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('sites/' + siteId + '.options.js');
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
}

/**
 * storage を組み込みサイト定義に正規化し、変更があれば保存する
 *
 * @param {Object|undefined} settings
 * @param {Object|undefined} state
 * @returns {Promise<{ settings: Object, state: Object }>}
 */
async function ensureNormalizedStorage(settings, state) {
  const normalized = normalizeBuiltinSites(settings, state);
  if (normalized.changed) {
    await chrome.storage.local.set({
      settings: normalized.settings,
      state: normalized.state
    });
  }
  return { settings: normalized.settings, state: normalized.state };
}

/**
 * サイト一覧を読み込んで表示する
 *
 * 組み込みサイトを固定表示し、storage から設定と状態を取得して
 * 各サイトの設定フォームと実行状態（nextRun、lastStatus 等）を表示する。
 *
 * 状態表示は読み取り専用で、ユーザーが誤って変更できないようにしている。
 */
async function loadSites() {
  const result = await chrome.storage.local.get(['settings', 'state']);
  const { settings, state } = await ensureNormalizedStorage(result.settings, result.state);
  
  // Slack Webhook URLを表示
  const slackWebhookUrlInput = document.getElementById('slack-webhook-url');
  if (slackWebhookUrlInput) {
    slackWebhookUrlInput.value = settings.slackWebhookUrl || '';
  }
  const slackSuccessWebhookUrlInput = document.getElementById('slack-success-webhook-url');
  if (slackSuccessWebhookUrlInput) {
    slackSuccessWebhookUrlInput.value = settings.slackSuccessWebhookUrl || '';
  }
  
  const container = document.getElementById('sites-container');
  container.innerHTML = '';
  
  const siteIds = BUILTIN_SITE_IDS;

  for (const siteId of siteIds) {
    const site = settings.sites[siteId];
    const siteState = state.bySite[siteId] || {};
    
    const siteDiv = document.createElement('details');
    siteDiv.className = 'site-section';
    siteDiv.id = `site-${siteId}`;
    // デフォルトは閉じた状態（open属性なし）
    
    siteDiv.innerHTML = `
      <summary class="site-header">
        <h2>${escapeHtml(siteId)}</h2>
      </summary>
      
      <div class="site-accordion-body">
      <div class="form-group">
        <label>
          <input type="checkbox" id="${siteId}-enabled" ${site.enabled ? 'checked' : ''}>
          有効
        </label>
      </div>
      
      <div class="form-group">
        <label>タイムアウト（秒）:</label>
        <input type="number" id="${siteId}-timeoutSec" value="${site.timeoutSec}" min="1" max="300">
      </div>
      
      <div class="form-group">
        <label>スケジュールタイプ:</label>
        <select id="${siteId}-schedule-type" data-site-id="${siteId}">
          <option value="hourly" ${site.schedule.type === 'hourly' ? 'selected' : ''}>毎時</option>
          <option value="daily" ${site.schedule.type === 'daily' ? 'selected' : ''}>毎日</option>
          <option value="weekly" ${site.schedule.type === 'weekly' ? 'selected' : ''}>毎週</option>
        </select>
      </div>
      
      <div class="schedule-fields" id="${siteId}-schedule-fields">
        ${renderScheduleFields(siteId, site.schedule)}
      </div>
      
      <div class="site-options" id="${siteId}-site-options"></div>
      
      <div class="state-display">
        <div class="state-item">
          <span class="state-label">URL:</span>
          ${escapeHtml(getBuiltinSiteUrl(siteId))}
          <button type="button" class="open-site-url" data-site-id="${escapeHtml(siteId)}" title="このURLを新しいタブで開く">開く</button>
        </div>
        <div class="state-item">
          <span class="state-label">次回実行:</span>
          ${siteState.nextRun ? new Date(siteState.nextRun).toLocaleString('ja-JP') : '未設定'}
        </div>
        <div class="state-item">
          <span class="state-label">最終ステータス:</span>
          <span class="${siteState.lastStatus === 'ok' ? 'status-ok' : 'status-fail'}">
            ${siteState.lastStatus || '未実行'}
          </span>
        </div>
        <div class="state-item">
          <span class="state-label">失敗回数:</span>
          ${siteState.failCount || 0}
        </div>
        <div class="state-item">
          <span class="state-label">最終実行:</span>
          ${siteState.lastRun ? new Date(siteState.lastRun).toLocaleString('ja-JP') : '未実行'}
        </div>
        ${siteState.lastError ? `
          <div class="state-item">
            <span class="state-label">最終エラー:</span>
            <span class="status-fail">${escapeHtml(siteState.lastError)}</span>
          </div>
        ` : ''}
      </div>
      
      <div style="margin-top: 15px; display: flex; gap: 10px;">
        <button class="save-site" data-site-id="${escapeHtml(siteId)}" style="background: #34a853;">保存</button>
        <button class="run-now" data-site-id="${escapeHtml(siteId)}" data-mock-mode="false">今すぐ実行</button>
        <button class="run-now" data-site-id="${escapeHtml(siteId)}" data-mock-mode="true" style="background: #ff9800;">今すぐ実行（モック）</button>
        <button class="run-now" data-site-id="${escapeHtml(siteId)}" data-local-mode="true" style="background: #7b1fa2;">今すぐ実行（ローカル）</button>
      </div>
      </div>
    `;
    
    container.appendChild(siteDiv);
    
    // サイト単位オプションを動的ロードしてフォーム項目を追加
    await loadSiteOptionsScript(siteId);
    const schema = (window.__SITE_OPTIONS__ || {})[siteId];
    if (schema && schema.length > 0) {
      const optionsContainer = document.getElementById(`${siteId}-site-options`);
      if (optionsContainer) {
        for (const opt of schema) {
          const inputId = `${siteId}-${opt.key}`;
          const value = site[opt.key] ?? '';
          const inputType = opt.type === 'password' ? 'password' : (opt.type === 'number' ? 'number' : 'text');
          const extraAttrs = [];
          if (opt.type === 'url') extraAttrs.push('placeholder="https://..."');
          if (opt.type === 'number' && opt.min != null) extraAttrs.push(`min="${opt.min}"`);
          if (opt.type === 'number' && opt.max != null) extraAttrs.push(`max="${opt.max}"`);
          const group = document.createElement('div');
          group.className = 'form-group';
          group.innerHTML = `
            <label for="${escapeHtml(inputId)}">${escapeHtml(opt.label)}:</label>
            <input type="${inputType}" id="${inputId}" value="${escapeHtml(String(value))}" ${extraAttrs.join(' ')}>
          `;
          optionsContainer.appendChild(group);
        }
      }
    }

    if (siteId === 'x-bookmarks') {
      appendProcessedTweetIdsSection(siteDiv, siteId, siteState.processedTweetIds || {});
    }

    // スケジュールタイプ変更のイベントリスナーを設定
    const scheduleTypeSelect = siteDiv.querySelector(`#${siteId}-schedule-type`);
    if (scheduleTypeSelect) {
      scheduleTypeSelect.addEventListener('change', () => {
        updateScheduleFields(siteId);
      });
    }

    attachScheduleEveryListeners(siteId);
    
    // URL「開く」ボタン
    const openUrlButton = siteDiv.querySelector('.open-site-url');
    if (openUrlButton) {
      openUrlButton.addEventListener('click', (e) => {
        e.preventDefault();
        const id = openUrlButton.getAttribute('data-site-id');
        const raw = getBuiltinSiteUrl(id);
        if (!raw) {
          alert(`サイト "${id}" の URL が定義されていません。`);
          return;
        }
        chrome.tabs.create({ url: raw });
      });
    }

    // 「保存」ボタンのイベントリスナーを設定
    const saveButton = siteDiv.querySelector('.save-site');
    if (saveButton) {
      saveButton.addEventListener('click', async () => {
        const siteId = saveButton.getAttribute('data-site-id');
        await saveSite(siteId);
      });
    }
    
    // 「今すぐ実行」ボタンのイベントリスナーを設定
    const runButtons = siteDiv.querySelectorAll('.run-now');
    runButtons.forEach(button => {
      button.addEventListener('click', async () => {
        const siteId = button.getAttribute('data-site-id');
        const localMode = button.getAttribute('data-local-mode') === 'true';
        const mockMode = !localMode && button.getAttribute('data-mock-mode') === 'true';

        const defaultLabel = button.getAttribute('data-mock-mode') === 'true'
          ? '今すぐ実行（モック）'
          : (button.getAttribute('data-local-mode') === 'true' ? '今すぐ実行（ローカル）' : '今すぐ実行');
        button.disabled = true;
        button.textContent = localMode ? '実行中（ローカル）...' : (mockMode ? '実行中（モック）...' : '実行中...');
        
        try {
          const response = await chrome.runtime.sendMessage({
            type: 'RUN_SITE',
            siteId,
            mockMode: localMode ? false : mockMode,
            localMode: localMode ? true : false
          });
          
          if (!response) {
            alert('実行中にエラーが発生しました: Service Worker が応答しませんでした。');
          } else if (response.success) {
            if (localMode) {
              alert('ローカル実行が完了しました。');
            } else if (mockMode) {
              alert('モック実行が完了しました。ChatGPT へ送信しました（処理済みマークは付けていません）。');
            } else {
              alert('実行が完了しました。');
            }
            await loadSites(); // 状態を更新
          } else {
            alert('実行中にエラーが発生しました: ' + (response.error || '不明なエラー'));
          }
        } catch (err) {
          alert('実行中にエラーが発生しました: ' + err.message);
        } finally {
          button.disabled = false;
          button.textContent = defaultLabel;
        }
      });
    });
  }
}

/**
 * スケジュール間隔の単位ラベル
 *
 * @param {string} type
 * @returns {string}
 */
function getScheduleEveryUnitLabel(type) {
  if (type === 'hourly') {
    return '時間ごと';
  }
  if (type === 'daily') {
    return '日ごと';
  }
  return '週ごと';
}

/**
 * @param {number} every
 * @param {string} type
 * @returns {string}
 */
function formatScheduleEveryLabel(every, type) {
  return `${every} ${getScheduleEveryUnitLabel(type)}`;
}

/**
 * @param {string} siteId
 * @param {Object} schedule
 * @returns {string}
 */
function renderScheduleEveryField(siteId, schedule) {
  const every = schedule.every ?? 1;
  return `
    <div class="form-group schedule-every-group">
      <label for="${siteId}-schedule-every">間隔:</label>
      <input type="number" id="${siteId}-schedule-every" value="${every}" min="1" max="23" data-site-id="${siteId}">
      <span id="${siteId}-schedule-every-label">${formatScheduleEveryLabel(every, schedule.type)}</span>
    </div>
  `;
}

/**
 * @param {string} siteId
 */
function updateScheduleEveryLabel(siteId) {
  const everyInput = document.getElementById(`${siteId}-schedule-every`);
  const label = document.getElementById(`${siteId}-schedule-every-label`);
  const typeSelect = document.getElementById(`${siteId}-schedule-type`);
  if (!everyInput || !label || !typeSelect) {
    return;
  }
  const every = parseInt(everyInput.value, 10);
  const validEvery = Number.isInteger(every) && every >= 1 && every <= 23 ? every : 1;
  label.textContent = formatScheduleEveryLabel(validEvery, typeSelect.value);
}

/**
 * @param {string} siteId
 */
function attachScheduleEveryListeners(siteId) {
  const everyInput = document.getElementById(`${siteId}-schedule-every`);
  if (everyInput) {
    everyInput.addEventListener('input', () => updateScheduleEveryLabel(siteId));
  }
}

/**
 * @param {string} siteId
 * @returns {number|null}
 */
function readScheduleEveryFromForm(siteId) {
  const everyValue = document.getElementById(`${siteId}-schedule-every`)?.value;
  const every = parseInt(everyValue, 10);
  if (!Number.isInteger(every) || every < 1 || every > 23) {
    return null;
  }
  return every;
}

/**
 * @param {string} siteId
 * @param {string} scheduleType
 * @returns {{ schedule?: Object, error?: string }}
 */
function buildScheduleFromForm(siteId, scheduleType) {
  const every = readScheduleEveryFromForm(siteId);
  if (every == null) {
    return { error: `サイト "${siteId}" の間隔は 1〜23 の整数で入力してください。` };
  }

  const schedule = { type: scheduleType, every };

  if (scheduleType === 'hourly') {
    const minuteValue = document.getElementById(`${siteId}-schedule-minute`).value;
    const minute = parseInt(minuteValue, 10);
    if (isNaN(minute) || minute < 0 || minute > 59) {
      return { error: `サイト "${siteId}" の分は0-59の範囲で入力してください。` };
    }
    schedule.minute = minute;
  } else if (scheduleType === 'daily') {
    const at = document.getElementById(`${siteId}-schedule-at`).value.trim();
    if (!isValidTimeFormat(at)) {
      return { error: `サイト "${siteId}" の時刻形式が正しくありません。HH:MM形式で入力してください。` };
    }
    schedule.at = at;
  } else if (scheduleType === 'weekly') {
    const dowValue = document.getElementById(`${siteId}-schedule-dow`).value;
    const dow = parseInt(dowValue, 10);
    if (isNaN(dow) || dow < 0 || dow > 6) {
      return { error: `サイト "${siteId}" の曜日が正しくありません。` };
    }
    const at = document.getElementById(`${siteId}-schedule-at`).value.trim();
    if (!isValidTimeFormat(at)) {
      return { error: `サイト "${siteId}" の時刻形式が正しくありません。HH:MM形式で入力してください。` };
    }
    schedule.dow = dow;
    schedule.at = at;
  }

  return { schedule };
}

/**
 * スケジュールタイプに応じた入力フィールドを生成する
 * 
 * スケジュールタイプ（hourly/daily/weekly）に応じて、
 * 必要な入力フィールドのみを表示する。
 * 
 * @param {string} siteId - サイトID（要素IDの生成に使用）
 * @param {Object} schedule - 現在のスケジュール設定
 * @returns {string} HTML文字列
 */
function renderScheduleFields(siteId, schedule) {
  const everyField = renderScheduleEveryField(siteId, schedule);

  if (schedule.type === 'hourly') {
    return `
      ${everyField}
      <div class="form-group">
        <label>分（0-59）:</label>
        <input type="number" id="${siteId}-schedule-minute" value="${schedule.minute || 0}" min="0" max="59">
      </div>
    `;
  } else if (schedule.type === 'daily') {
    return `
      ${everyField}
      <div class="form-group">
        <label>時刻（HH:MM）:</label>
        <input type="text" id="${siteId}-schedule-at" value="${schedule.at || '00:00'}" pattern="[0-9]{2}:[0-9]{2}" placeholder="HH:MM">
      </div>
    `;
  } else if (schedule.type === 'weekly') {
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    return `
      ${everyField}
      <div class="form-group">
        <label>曜日:</label>
        <select id="${siteId}-schedule-dow">
          ${days.map((day, idx) => `
            <option value="${idx}" ${schedule.dow === idx ? 'selected' : ''}>${day}曜日</option>
          `).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>時刻（HH:MM）:</label>
        <input type="text" id="${siteId}-schedule-at" value="${schedule.at || '00:00'}" pattern="[0-9]{2}:[0-9]{2}" placeholder="HH:MM">
      </div>
    `;
  }
  return everyField;
}

/**
 * スケジュールタイプ変更時に入力フィールドを更新する
 * 
 * ユーザーがスケジュールタイプを変更した際に、
 * 新しいタイプに応じた入力フィールドに切り替える。
 * 既存の値はリセットされ、デフォルト値が設定される。
 * 
 * @param {string} siteId - サイトID
 */
function updateScheduleFields(siteId) {
  const type = document.getElementById(`${siteId}-schedule-type`).value;
  const siteDiv = document.getElementById(`site-${siteId}`);
  const fieldsDiv = document.getElementById(`${siteId}-schedule-fields`);
  
  let schedule = { type, every: 1 };
  if (type === 'hourly') {
    schedule.minute = 0;
  } else if (type === 'daily') {
    schedule.at = '00:00';
  } else if (type === 'weekly') {
    schedule.dow = 0;
    schedule.at = '00:00';
  }

  fieldsDiv.innerHTML = renderScheduleFields(siteId, schedule);
  attachScheduleEveryListeners(siteId);
}

/**
 * フォームの Slack Webhook URL を settings オブジェクトに反映する（storage 保存はしない）
 *
 * @param {Object} settings - 更新対象の settings
 * @returns {boolean} 検証に成功したら true、失敗時は alert 済みで false
 */
function applySlackWebhookFromForm(settings) {
  const slackWebhookUrlInput = document.getElementById('slack-webhook-url');
  const slackSuccessWebhookUrlInput = document.getElementById('slack-success-webhook-url');
  if (!slackWebhookUrlInput) {
    return true;
  }
  const slackWebhookUrl = slackWebhookUrlInput.value.trim();
  if (slackWebhookUrl) {
    try {
      new URL(slackWebhookUrl);
      settings.slackWebhookUrl = slackWebhookUrl;
    } catch {
      alert('Slack Webhook URL（失敗・0件時）の形式が正しくありません。');
      return false;
    }
  } else {
    delete settings.slackWebhookUrl;
  }
  if (slackSuccessWebhookUrlInput) {
    const successUrl = slackSuccessWebhookUrlInput.value.trim();
    if (successUrl) {
      try {
        new URL(successUrl);
        settings.slackSuccessWebhookUrl = successUrl;
      } catch {
        alert('Slack Webhook URL（成功・稼働確認）の形式が正しくありません。');
        return false;
      }
    } else {
      delete settings.slackSuccessWebhookUrl;
    }
  }
  return true;
}

/**
 * 通知設定（Slack Webhook のみ）を storage に保存する
 */
async function saveNotificationSettings() {
  const result = await chrome.storage.local.get('settings');
  const settings = result.settings || { sites: {} };
  if (!applySlackWebhookFromForm(settings)) {
    return;
  }
  await chrome.storage.local.set({ settings });
  alert('通知設定を保存しました');
}

/**
 * 指定されたサイトの設定を保存する
 * 
 * フォームから設定を読み取り、バリデーションを実施してからstorageに保存する。
 * バリデーションエラーがある場合は保存せず、ユーザーに通知する。
 * 
 * 保存後、初回登場サイトの nextRun を初期化する。
 * 既存サイトのnextRunは変更しない（スケジュール変更時も次回実行時刻は保持）。
 * 
 * @param {string} siteId - 保存対象のサイトID
 */
async function saveSite(siteId) {
  if (!isBuiltinSiteId(siteId)) {
    alert(`サイト "${siteId}" は組み込みサイトではありません。`);
    return;
  }

  const result = await chrome.storage.local.get(['settings', 'state']);
  const { settings } = await ensureNormalizedStorage(result.settings, result.state);
  
  if (!settings.sites[siteId]) {
    alert(`サイト "${siteId}" が見つかりません。`);
    return;
  }
  
  const enabled = document.getElementById(`${siteId}-enabled`).checked;
  const url = getBuiltinSiteUrl(siteId);
  const timeoutSecValue = document.getElementById(`${siteId}-timeoutSec`).value;
  const scheduleType = document.getElementById(`${siteId}-schedule-type`).value;

  // タイムアウトは1-300秒の範囲に制限
  // 短すぎるとタイムアウトが頻発し、長すぎるとリソースを消費しすぎる
  const timeoutSec = parseInt(timeoutSecValue, 10);
  if (isNaN(timeoutSec) || timeoutSec < 1 || timeoutSec > 300) {
    alert(`サイト "${siteId}" のタイムアウトは1-300秒の範囲で入力してください。`);
    return;
  }

  const built = buildScheduleFromForm(siteId, scheduleType);
  if (built.error) {
    alert(built.error);
    return;
  }
  const schedule = built.schedule;
  
  const siteData = {
    url,
    enabled,
    timeoutSec,
    schedule
  };
  
  // サイト単位オプション（スキーマで定義された項目）をフォームから読み取り保存
  const schema = (window.__SITE_OPTIONS__ || {})[siteId];
  if (schema && schema.length > 0) {
    for (const opt of schema) {
      const el = document.getElementById(`${siteId}-${opt.key}`);
      if (el) {
        const value = el.value.trim();
        if (opt.type === 'url' && value && !isValidApiUrl(value)) {
          alert(`サイト "${siteId}" の${opt.label}の形式が正しくありません。http:// または https:// で始まるURLを入力してください。`);
          return;
        }
        if (opt.type === 'number' && value) {
          const n = parseInt(value, 10);
          const min = opt.min != null ? opt.min : 1;
          const max = opt.max != null ? opt.max : Number.MAX_SAFE_INTEGER;
          if (!Number.isFinite(n) || n < min || n > max) {
            alert(`サイト "${siteId}" の${opt.label}は ${min}〜${max} の整数で入力してください。`);
            return;
          }
        }
        siteData[opt.key] = value;
      }
    }
  }
  
  settings.sites[siteId] = siteData;
  await chrome.storage.local.set({ settings });
  
  // 初回登場サイトの nextRun を初期化
  // 既存サイトのnextRunは変更しない（スケジュール変更時も次回実行時刻は保持）
  let { state } = await chrome.storage.local.get('state');
  const now = Date.now();
  if (!state || !state.bySite) {
    state = { bySite: {} };
  }

  if (!state.bySite[siteId]) {
    state.bySite[siteId] = {
      nextRun: computeNextRunAfterSuccess(now, siteData.schedule, { mode: 'initial' })
    };
    await chrome.storage.local.set({ state });
  }

  alert(`サイト "${siteId}" の設定を保存しました`);
  await loadSites();
}

/**
 * すべてのサイト設定を保存する
 * 
 * フォームから設定を読み取り、バリデーションを実施してからstorageに保存する。
 * バリデーションエラーがある場合は保存せず、ユーザーに通知する。
 * 
 * 保存後、初回登場サイトの nextRun を初期化する。
 * 既存サイトのnextRunは変更しない（スケジュール変更時も次回実行時刻は保持）。
 */
async function saveAllSites() {
  const result = await chrome.storage.local.get(['settings', 'state']);
  const { settings } = await ensureNormalizedStorage(result.settings, result.state);

  if (!applySlackWebhookFromForm(settings)) {
    return;
  }

  for (const siteId of BUILTIN_SITE_IDS) {
    const enabled = document.getElementById(`${siteId}-enabled`).checked;
    const url = getBuiltinSiteUrl(siteId);
    const timeoutSecValue = document.getElementById(`${siteId}-timeoutSec`).value;
    const scheduleType = document.getElementById(`${siteId}-schedule-type`).value;

    // タイムアウトは1-300秒の範囲に制限
    // 短すぎるとタイムアウトが頻発し、長すぎるとリソースを消費しすぎる
    const timeoutSec = parseInt(timeoutSecValue, 10);
    if (isNaN(timeoutSec) || timeoutSec < 1 || timeoutSec > 300) {
      alert(`サイト "${siteId}" のタイムアウトは1-300秒の範囲で入力してください。`);
      return;
    }

    const built = buildScheduleFromForm(siteId, scheduleType);
    if (built.error) {
      alert(built.error);
      return;
    }
    const schedule = built.schedule;
    
    const siteData = {
      url,
      enabled,
      timeoutSec,
      schedule
    };
    
    // サイト単位オプション（スキーマで定義された項目）をフォームから読み取り保存
    const schema = (window.__SITE_OPTIONS__ || {})[siteId];
    if (schema && schema.length > 0) {
      for (const opt of schema) {
        const el = document.getElementById(`${siteId}-${opt.key}`);
        if (el) {
          const value = el.value.trim();
          if (opt.type === 'url' && value && !isValidApiUrl(value)) {
            alert(`サイト "${siteId}" の${opt.label}の形式が正しくありません。http:// または https:// で始まるURLを入力してください。`);
            return;
          }
          if (opt.type === 'number' && value) {
            const n = parseInt(value, 10);
            const min = opt.min != null ? opt.min : 1;
            const max = opt.max != null ? opt.max : Number.MAX_SAFE_INTEGER;
            if (!Number.isFinite(n) || n < min || n > max) {
              alert(`サイト "${siteId}" の${opt.label}は ${min}〜${max} の整数で入力してください。`);
              return;
            }
          }
          siteData[opt.key] = value;
        }
      }
    }
    
    settings.sites[siteId] = siteData;
  }
  
  await chrome.storage.local.set({ settings });
  
  // 初回登場サイトの nextRun を初期化
  // 既存サイトのnextRunは変更しない（スケジュール変更時も次回実行時刻は保持）
  let { state } = await chrome.storage.local.get('state');
  const now = Date.now();
  if (!state || !state.bySite) {
    state = { bySite: {} };
  }

  for (const siteId of BUILTIN_SITE_IDS) {
    if (!state.bySite[siteId]) {
      const site = settings.sites[siteId];
      state.bySite[siteId] = {
        nextRun: computeNextRunAfterSuccess(now, site.schedule, { mode: 'initial' })
      };
    }
  }

  await chrome.storage.local.set({ state });

  alert('設定を保存しました');
  await loadSites();
}

/**
 * HTMLエスケープ処理
 * 
 * XSS対策として、ユーザー入力値をHTMLに埋め込む前にエスケープする。
 * DOM APIのtextContentを使用することで、確実にエスケープされる。
 * 
 * @param {string} text - エスケープ対象の文字列
 * @returns {string} エスケープ済みの文字列
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}


// ページ読み込み時にサイト一覧を表示し、イベントリスナーを設定
document.addEventListener('DOMContentLoaded', () => {
  loadSites();
  refreshOptionsApiLog();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[OPTIONS_API_LOG_STORAGE_KEY]) {
      return;
    }
    renderOptionsApiLog(changes[OPTIONS_API_LOG_STORAGE_KEY].newValue);
  });

  const logRefresh = document.getElementById('options-api-log-refresh');
  if (logRefresh) {
    logRefresh.addEventListener('click', () => refreshOptionsApiLog());
  }
  const logClear = document.getElementById('options-api-log-clear');
  if (logClear) {
    logClear.addEventListener('click', () => clearOptionsApiLog());
  }

  // すべて保存ボタンのイベントリスナー
  const saveAllButton = document.getElementById('save-all-button');
  if (saveAllButton) {
    saveAllButton.addEventListener('click', saveAllSites);
  }

  const saveNotificationButton = document.getElementById('save-notification-button');
  if (saveNotificationButton) {
    saveNotificationButton.addEventListener('click', saveNotificationSettings);
  }
});

