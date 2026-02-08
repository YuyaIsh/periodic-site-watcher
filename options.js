// Options Page: 設定編集、storage保存

/**
 * 新規サイト追加時のデフォルト設定
 * 
 * ユーザーが最小限の入力でサイトを追加できるよう、
 * 安全なデフォルト値を設定している。
 */
const DEFAULT_SITE = {
  url: '',
  enabled: true,
  timeoutSec: 30,
  schedule: {
    type: 'hourly',
    minute: 0
  }
};

/**
 * サイト一覧を読み込んで表示する
 * 
 * storageから設定と状態を取得し、各サイトの設定フォームと
 * 実行状態（nextRun、lastStatus等）を表示する。
 * 
 * 状態表示は読み取り専用で、ユーザーが誤って変更できないようにしている。
 */
async function loadSites() {
  const result = await chrome.storage.local.get(['settings', 'state']);
  const settings = result.settings || { sites: {} };
  const state = result.state || { bySite: {} };
  
  // API URLを表示
  const apiUrlInput = document.getElementById('api-url');
  if (apiUrlInput) {
    apiUrlInput.value = settings.apiUrl || 'http://localhost:3000/collect';
  }
  
  const container = document.getElementById('sites-container');
  container.innerHTML = '';
  
  const siteIds = Object.keys(settings.sites).sort();
  
  if (siteIds.length === 0) {
    container.innerHTML = '<p>サイトが登録されていません。上記から追加してください。</p>';
    return;
  }
  
  for (const siteId of siteIds) {
    const site = settings.sites[siteId];
    const siteState = state.bySite[siteId] || {};
    
    const siteDiv = document.createElement('div');
    siteDiv.className = 'site-section';
    siteDiv.id = `site-${siteId}`;
    
    siteDiv.innerHTML = `
      <div class="site-header">
        <h2>${escapeHtml(siteId)}</h2>
        <button class="delete" data-site-id="${escapeHtml(siteId)}">削除</button>
      </div>
      
      <div class="form-group">
        <label>
          <input type="checkbox" id="${siteId}-enabled" ${site.enabled ? 'checked' : ''}>
          有効
        </label>
      </div>
      
      <div class="form-group">
        <label>URL:</label>
        <input type="text" id="${siteId}-url" value="${escapeHtml(site.url)}" placeholder="https://example.com">
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
      
      <div class="state-display">
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
    `;
    
    container.appendChild(siteDiv);
    
    // 削除ボタンのイベントリスナーを設定
    const deleteButton = siteDiv.querySelector('.delete');
    if (deleteButton) {
      deleteButton.addEventListener('click', () => {
        deleteSite(siteId);
      });
    }
    
    // スケジュールタイプ変更のイベントリスナーを設定
    const scheduleTypeSelect = siteDiv.querySelector(`#${siteId}-schedule-type`);
    if (scheduleTypeSelect) {
      scheduleTypeSelect.addEventListener('change', () => {
        updateScheduleFields(siteId);
      });
    }
  }
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
  if (schedule.type === 'hourly') {
    return `
      <div class="form-group">
        <label>分（0-59）:</label>
        <input type="number" id="${siteId}-schedule-minute" value="${schedule.minute || 0}" min="0" max="59">
      </div>
    `;
  } else if (schedule.type === 'daily') {
    return `
      <div class="form-group">
        <label>時刻（HH:MM）:</label>
        <input type="text" id="${siteId}-schedule-at" value="${schedule.at || '00:00'}" pattern="[0-9]{2}:[0-9]{2}" placeholder="HH:MM">
      </div>
    `;
  } else if (schedule.type === 'weekly') {
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    return `
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
  return '';
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
  
  let schedule = { type };
  if (type === 'hourly') {
    schedule.minute = 0;
  } else if (type === 'daily') {
    schedule.at = '00:00';
  } else if (type === 'weekly') {
    schedule.dow = 0;
    schedule.at = '00:00';
  }
  
  fieldsDiv.innerHTML = renderScheduleFields(siteId, schedule);
}

/**
 * API URLのバリデーション
 * 
 * SSRF（Server-Side Request Forgery）対策として、
 * プロトコルをhttp/httpsに制限する。
 * file://、ftp://等の内部ネットワークへのアクセスを防止する。
 * 
 * @param {string} url - 検証対象のURL
 * @returns {boolean} 有効なURLの場合true
 */
function isValidApiUrl(url) {
  if (!url || !url.trim()) {
    return false;
  }
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 時刻形式のバリデーション（HH:MM）
 * 
 * 正規表現で形式をチェックし、さらに数値範囲（0-23時、0-59分）を検証する。
 * 文字列の形式チェックだけでは"25:00"や"12:60"が通ってしまうため、
 * 数値範囲の検証も必須。
 * 
 * @param {string} time - 検証対象の時刻文字列
 * @returns {boolean} 有効な時刻形式の場合true
 */
function isValidTimeFormat(time) {
  if (!time || typeof time !== 'string') {
    return false;
  }
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return false;
  }
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  return hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60;
}

/**
 * すべてのサイト設定を保存する
 * 
 * フォームから設定を読み取り、バリデーションを実施してからstorageに保存する。
 * バリデーションエラーがある場合は保存せず、ユーザーに通知する。
 * 
 * 保存後、新規追加されたサイトのnextRunを初期化する。
 * 既存サイトのnextRunは変更しない（スケジュール変更時も次回実行時刻は保持）。
 */
async function saveAllSites() {
  const result = await chrome.storage.local.get('settings');
  const settings = result.settings || { sites: {} };
  
  const apiUrlInput = document.getElementById('api-url');
  if (apiUrlInput) {
    const apiUrl = apiUrlInput.value.trim() || 'http://localhost:3000/collect';
    if (!isValidApiUrl(apiUrl)) {
      alert('API URLの形式が正しくありません。http:// または https:// で始まるURLを入力してください。');
      return;
    }
    settings.apiUrl = apiUrl;
  }
  
  for (const siteId of Object.keys(settings.sites)) {
    const enabled = document.getElementById(`${siteId}-enabled`).checked;
    const url = document.getElementById(`${siteId}-url`).value.trim();
    const timeoutSecValue = document.getElementById(`${siteId}-timeoutSec`).value;
    const scheduleType = document.getElementById(`${siteId}-schedule-type`).value;
    
    // URLは必須（空文字列は無効）
    if (!url) {
      alert(`サイト "${siteId}" のURLが入力されていません。`);
      return;
    }
    // URL形式の検証（URLコンストラクタで構文チェック）
    try {
      new URL(url);
    } catch {
      alert(`サイト "${siteId}" のURL形式が正しくありません。`);
      return;
    }
    
    // タイムアウトは1-300秒の範囲に制限
    // 短すぎるとタイムアウトが頻発し、長すぎるとリソースを消費しすぎる
    const timeoutSec = parseInt(timeoutSecValue, 10);
    if (isNaN(timeoutSec) || timeoutSec < 1 || timeoutSec > 300) {
      alert(`サイト "${siteId}" のタイムアウトは1-300秒の範囲で入力してください。`);
      return;
    }
    
    let schedule = { type: scheduleType };
    
    if (scheduleType === 'hourly') {
      const minuteValue = document.getElementById(`${siteId}-schedule-minute`).value;
      const minute = parseInt(minuteValue, 10);
      if (isNaN(minute) || minute < 0 || minute > 59) {
        alert(`サイト "${siteId}" の分は0-59の範囲で入力してください。`);
        return;
      }
      schedule.minute = minute;
    } else if (scheduleType === 'daily') {
      const at = document.getElementById(`${siteId}-schedule-at`).value.trim();
      if (!isValidTimeFormat(at)) {
        alert(`サイト "${siteId}" の時刻形式が正しくありません。HH:MM形式で入力してください。`);
        return;
      }
      schedule.at = at;
    } else if (scheduleType === 'weekly') {
      const dowValue = document.getElementById(`${siteId}-schedule-dow`).value;
      const dow = parseInt(dowValue, 10);
      if (isNaN(dow) || dow < 0 || dow > 6) {
        alert(`サイト "${siteId}" の曜日が正しくありません。`);
        return;
      }
      const at = document.getElementById(`${siteId}-schedule-at`).value.trim();
      if (!isValidTimeFormat(at)) {
        alert(`サイト "${siteId}" の時刻形式が正しくありません。HH:MM形式で入力してください。`);
        return;
      }
      schedule.dow = dow;
      schedule.at = at;
    }
    
    settings.sites[siteId] = {
      url,
      enabled,
      timeoutSec,
      schedule
    };
  }
  
  await chrome.storage.local.set({ settings });
  
  // 新規追加されたサイトのnextRunを初期化
  // 既存サイトのnextRunは変更しない（スケジュール変更時も次回実行時刻は保持）
  let { state } = await chrome.storage.local.get('state');
  const now = Date.now();
  if (!state || !state.bySite) {
    state = { bySite: {} };
  }
  
  for (const siteId of Object.keys(settings.sites)) {
    if (!state.bySite[siteId]) {
      const site = settings.sites[siteId];
      state.bySite[siteId] = {
        nextRun: computeNextRunAfterSuccess(now, site.schedule)
      };
    }
  }
  
  await chrome.storage.local.set({ state });
  
  alert('設定を保存しました');
  await loadSites();
}

/**
 * 新規サイトを追加する
 * 
 * siteIdの重複チェックを行い、デフォルト設定で新規サイトを作成する。
 * 追加後は一覧を再読み込みして、新規サイトの設定フォームを表示する。
 */
async function addNewSite() {
  const siteIdInput = document.getElementById('new-site-id');
  const siteId = siteIdInput.value.trim();
  
  if (!siteId) {
    alert('Site IDを入力してください');
    return;
  }
  
  const result = await chrome.storage.local.get('settings');
  const settings = result.settings || { sites: {} };
  
  if (settings.sites[siteId]) {
    alert('このSite IDは既に存在します');
    return;
  }
  
  settings.sites[siteId] = { ...DEFAULT_SITE };
  await chrome.storage.local.set({ settings });
  
  siteIdInput.value = '';
  await loadSites();
}

/**
 * サイトを削除する
 * 
 * 確認ダイアログを表示し、承認された場合のみ削除する。
 * settingsとstateの両方から削除する（整合性を保つため）。
 */
async function deleteSite(siteId) {
  if (!confirm(`サイト "${siteId}" を削除しますか？`)) {
    return;
  }
  
  const result = await chrome.storage.local.get(['settings', 'state']);
  const settings = result.settings || { sites: {} };
  const state = result.state || { bySite: {} };
  
  delete settings.sites[siteId];
  delete state.bySite[siteId];
  
  await chrome.storage.local.set({ settings, state });
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

/**
 * スケジュール計算関数（Options Page用）
 * 
 * service-worker.jsのcomputeNextRunAfterSuccessと同じロジック。
 * Options Pageで次回実行時刻を表示するために使用する。
 * 
 * コード重複はあるが、Options PageとService Workerは異なるコンテキストで
 * 実行されるため、共通モジュール化は困難（現時点では重複を許容）。
 * 
 * @param {number} now - 現在時刻（epoch ms）
 * @param {Object} schedule - スケジュール設定
 * @returns {number} 次回実行時刻（epoch ms）
 */
function computeNextRunAfterSuccess(now, schedule) {
  const date = new Date(now);
  
  if (schedule.type === 'hourly') {
    date.setMinutes(schedule.minute, 0, 0);
    if (date.getTime() <= now) {
      date.setHours(date.getHours() + 1);
    }
    return date.getTime();
  } else if (schedule.type === 'daily') {
    const [hours, minutes] = schedule.at.split(':').map(Number);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() <= now) {
      date.setDate(date.getDate() + 1);
    }
    return date.getTime();
  } else if (schedule.type === 'weekly') {
    const [hours, minutes] = schedule.at.split(':').map(Number);
    const currentDay = date.getDay();
    const targetDay = schedule.dow;
    let daysToAdd = (targetDay - currentDay + 7) % 7;
    
    date.setHours(hours, minutes, 0, 0);
    if (daysToAdd === 0 && date.getTime() <= now) {
      daysToAdd = 7;
    }
    date.setDate(date.getDate() + daysToAdd);
    return date.getTime();
  }
  
  return now + 60 * 60 * 1000;
}

// ページ読み込み時にサイト一覧を表示し、イベントリスナーを設定
document.addEventListener('DOMContentLoaded', () => {
  loadSites();
  
  // サイト追加ボタンのイベントリスナー
  const addSiteButton = document.getElementById('add-site-button');
  if (addSiteButton) {
    addSiteButton.addEventListener('click', addNewSite);
  }
  
  // すべて保存ボタンのイベントリスナー
  const saveAllButton = document.getElementById('save-all-button');
  if (saveAllButton) {
    saveAllButton.addEventListener('click', saveAllSites);
  }
});

