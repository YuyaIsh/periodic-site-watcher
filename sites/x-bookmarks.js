/**
 * Notion APIのレート制限対応待機時間（ミリ秒）
 * Notion APIのレート制限は3リクエスト/秒のため、350ms待機
 */
const NOTION_API_RATE_LIMIT_DELAY_MS = 350;

/**
 * レート制限エラー（429）の最大再試行回数
 */
const MAX_RETRY_COUNT = 3;

/**
 * サイト別データ抽出アダプタ関数
 * 
 * xのブックマークに追加されたものを取得
 * ローカルLLMでブックマークしたポストの内容を調査
 * Notionの気になるツールDBに内容を保存
 * (https://www.notion.so/9811105a3e684424b437e5c81c518395?source=copy_link)
 * その内容をSlackにも送信
 * 
 * @returns {Promise<Object>} 抽出したデータ（サイト別の形式）
 */
async function collect_x_bookmarks() {
  // Phase 2: ツイート抽出とNotion API送信統合
  // Phase 3: 引用RTの基本対応（URLとツイートIDのみ保存）
  
  // 1. DOMから全ツイート要素を取得
  const tweetElements = extractTweetElements();
  
  if (tweetElements.length === 0) {
    console.warn('ツイート要素が見つかりませんでした');
    return { tweets: [] };
  }
  
  // 2. 各ツイートから基本情報を抽出（重複チェック付き）
  const tweets = [];
  const seenTweetIds = new Set(); // 重複チェック用
  
  for (const element of tweetElements) {
    try {
      const tweetData = extractTweetBasicData(element);
      if (tweetData && !seenTweetIds.has(tweetData.tweetId)) {
        seenTweetIds.add(tweetData.tweetId);
        tweets.push(tweetData);
      }
    } catch (error) {
      console.warn('ツイート抽出エラー:', error);
      // 個別ツイートのエラーはスキップして続行
    }
  }
  
  // 3. 設定を取得（モックモード時は設定を取得しない）
  const mockMode = window.__COLLECT_MOCK_MODE__ === true;
  let config = null;
  
  if (!mockMode) {
    // 通常モード: 設定を取得
    const result = await chrome.storage.local.get('settings');
    const settings = result.settings || {};
    const siteSettings = settings.sites?.['x-bookmarks'] || {};
    
    const notionApiKey = siteSettings.notionApiKey;
    const notionDatabaseId = siteSettings.notionDatabaseId;
    
    // API Key/Database IDの検証（空文字列や空白のみもチェック）
    if (!notionApiKey || !notionDatabaseId || 
        notionApiKey.trim() === '' || notionDatabaseId.trim() === '') {
      throw new Error('Notion API KeyまたはDatabase IDが設定されていません');
    }
    
    config = {
      notionApiKey: notionApiKey.trim(),
      notionDatabaseId: notionDatabaseId.trim()
    };
  }
  
  // 4. 各ツイートをNotion APIに送信（モックモード時もsendTweetToNotionを呼び出す）
  for (const tweet of tweets) {
    try {
      // モックモード時はconfigがnullでもsendTweetToNotion内で処理される
      await sendTweetToNotionWithRetry(tweet, config);
      // レート制限対応: 待機
      await new Promise(resolve => setTimeout(resolve, NOTION_API_RATE_LIMIT_DELAY_MS));
    } catch (error) {
      // 認証エラー（401）の場合は全体を失敗としてthrow
      if (error.message && error.message.includes('認証エラー')) {
        throw error;
      }
      // その他のエラーは個別ツイートをスキップして続行
      console.warn('ツイート送信エラー:', error.message);
    }
  }
  
  return { tweets };
}

/**
 * DOMからツイート要素を抽出する
 * 
 * @returns {NodeListOf<Element>} ツイート要素のリスト
 */
function extractTweetElements() {
  return document.querySelectorAll('article[data-testid="tweet"]');
}

/**
 * 各ツイートから基本情報を抽出する
 * 
 * @param {Element} tweetElement - ツイート要素（article[data-testid="tweet"]）
 * @returns {Object|null} ツイートデータオブジェクト（抽出失敗時はnull）
 */
function extractTweetBasicData(tweetElement) {
  // 2.1 ツイートIDの抽出
  const tweetId = extractTweetId(tweetElement);
  if (!tweetId) {
    return null;
  }
  
  // 2.2 ツイートURLの生成
  const url = extractTweetUrl(tweetElement, tweetId);
  
  // 2.3 ツイート本文の抽出
  const text = extractTweetText(tweetElement);
  
  // 2.4 投稿者情報の抽出
  const author = extractAuthorInfo(tweetElement);
  
  // 2.5 投稿日時の抽出
  const postedAt = extractPostedAt(tweetElement);
  
  // 2.6 引用RTの抽出（Phase 3）
  const quotedTweet = extractQuotedTweet(tweetElement);
  
  return {
    tweetId,
    url,
    text,
    author,
    postedAt,
    quotedTweet
  };
}

/**
 * ツイートIDを抽出する
 * 
 * @param {Element} tweetElement - ツイート要素
 * @returns {string|null} ツイートID（抽出失敗時はnull）
 */
function extractTweetId(tweetElement) {
  // href="/username/status/{tweetId}"形式のリンクから抽出
  const links = tweetElement.querySelectorAll('a[href*="/status/"]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (href) {
      const match = href.match(/\/status\/(\d+)/);
      if (match && match[1]) {
        return match[1];
      }
    }
  }
  return null;
}

/**
 * ツイートURLを生成する
 * 
 * @param {Element} tweetElement - ツイート要素
 * @param {string} tweetId - ツイートID
 * @returns {string} ツイートURL
 */
function extractTweetUrl(tweetElement, tweetId) {
  // スクリーンネームを取得
  const screenName = extractScreenName(tweetElement);
  if (screenName) {
    return buildTweetUrl(`/${screenName}/status/${tweetId}`, tweetId);
  }
  // スクリーンネームが取得できない場合はIDのみ
  return buildTweetUrl('', tweetId);
}

/**
 * ツイート本文を抽出する
 * 
 * @param {Element} tweetElement - ツイート要素
 * @returns {string} ツイート本文（HTMLタグを除去したプレーンテキスト）
 */
function extractTweetText(tweetElement) {
  const textElement = tweetElement.querySelector('[data-testid="tweetText"]');
  if (!textElement) {
    return '';
  }
  
  // HTMLタグを除去してプレーンテキストに変換
  return textElement.innerText || textElement.textContent || '';
}

/**
 * 投稿者情報を抽出する
 * 
 * @param {Element} tweetElement - ツイート要素
 * @returns {Object} 投稿者情報オブジェクト
 */
function extractAuthorInfo(tweetElement) {
  const userElement = tweetElement.querySelector('[data-testid="User-Name"]');
  
  // 表示名の取得
  let displayName = '';
  if (userElement) {
    const nameElement = userElement.querySelector('span');
    if (nameElement) {
      displayName = nameElement.innerText || nameElement.textContent || '';
    }
  }
  
  // スクリーンネームの取得
  const screenName = extractScreenName(tweetElement);
  
  // プロフィール画像URLの取得
  const profileImageUrl = extractProfileImageUrl(tweetElement);
  
  return {
    displayName: displayName.trim(),
    screenName: screenName || '',
    profileImageUrl: profileImageUrl || ''
  };
}

/**
 * スクリーンネームを抽出する
 * 
 * @param {Element} tweetElement - ツイート要素
 * @returns {string|null} スクリーンネーム（@を除く）
 */
function extractScreenName(tweetElement) {
  // User-Name要素内のリンクを優先的に検索（誤抽出を防止）
  const userElement = tweetElement.querySelector('[data-testid="User-Name"]');
  if (userElement) {
    const link = userElement.querySelector('a[href^="/"]');
    if (link) {
      const href = link.getAttribute('href');
      if (href) {
        const match = href.match(/^\/([^\/]+)$/);
        if (match && match[1] && !match[1].includes('status')) {
          return match[1];
        }
      }
    }
  }
  
  // フォールバック: @username形式のリンクから抽出
  const links = tweetElement.querySelectorAll('a[href^="/"]');
  for (const link of links) {
    const href = link.getAttribute('href');
    const text = link.innerText || link.textContent || '';
    
    // hrefが"/username"形式で、textが"@username"形式の場合
    if (href && href.startsWith('/') && !href.includes('/status/') && text.startsWith('@')) {
      const match = href.match(/^\/([^\/]+)$/);
      if (match && match[1]) {
        return match[1];
      }
    }
  }
  return null;
}

/**
 * プロフィール画像URLを抽出する
 * 
 * @param {Element} tweetElement - ツイート要素
 * @returns {string|null} プロフィール画像URL
 */
function extractProfileImageUrl(tweetElement) {
  const avatarElement = tweetElement.querySelector('[data-testid="UserAvatar"]');
  if (avatarElement) {
    const img = avatarElement.querySelector('img');
    if (img && img.src) {
      return img.src;
    }
  }
  return null;
}

/**
 * 投稿日時を抽出する
 * 
 * @param {Element} tweetElement - ツイート要素
 * @returns {string} ISO 8601形式の日時文字列
 */
function extractPostedAt(tweetElement) {
  const timeElement = tweetElement.querySelector('time[datetime]');
  if (timeElement) {
    const datetime = timeElement.getAttribute('datetime');
    if (datetime) {
      // 有効な日時か検証
      const date = new Date(datetime);
      if (!isNaN(date.getTime())) {
        return datetime;
      }
    }
  }
  // 日時が取得できない場合は現在時刻を使用
  return new Date().toISOString();
}

/**
 * ツイートURLを生成する（共通関数）
 * 
 * @param {string} href - href属性の値
 * @param {string} tweetId - ツイートID
 * @returns {string} 完全なツイートURL
 */
function buildTweetUrl(href, tweetId) {
  if (!href || !tweetId) {
    return `https://x.com/i/web/status/${tweetId || ''}`;
  }
  
  if (href.startsWith('http')) {
    // 既に完全なURLの場合
    return href;
  }
  
  if (href.startsWith('/')) {
    // 相対パスの場合
    const screenNameMatch = href.match(/^\/([^\/]+)\/status\//);
    if (screenNameMatch && screenNameMatch[1]) {
      return `https://x.com${href}`;
    }
    // スクリーンネームが取得できない場合はIDのみ
    return `https://x.com/i/web/status/${tweetId}`;
  }
  
  // その他の形式の場合はIDのみ
  return `https://x.com/i/web/status/${tweetId}`;
}

/**
 * 引用RTを抽出する（Phase 3: 基本対応）
 * 
 * @param {Element} tweetElement - ツイート要素
 * @returns {Object|null} 引用RTデータオブジェクト（引用RTがない場合はnull）
 */
function extractQuotedTweet(tweetElement) {
  try {
    // 引用RTの判定: [data-testid="card.wrapper"]が存在する場合
    const cardWrapper = tweetElement.querySelector('[data-testid="card.wrapper"]');
    if (!cardWrapper) {
      return null;
    }
    
    // 引用RT内のリンクから元ツイートのURLとツイートIDを抽出
    // 通常は1つのリンクのみだが、最初に見つかったものを使用
    const links = cardWrapper.querySelectorAll('a[href*="/status/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) {
        continue;
      }
      
      const match = href.match(/\/status\/(\d+)/);
      if (!match || !match[1]) {
        continue;
      }
      
      const quotedTweetId = match[1];
      const quotedUrl = buildTweetUrl(href, quotedTweetId);
      
      return {
        tweetId: quotedTweetId,
        url: quotedUrl
      };
    }
    
    return null;
  } catch (error) {
    console.warn('引用RT抽出エラー:', error);
    return null; // エラー時は引用RTなしとして扱う
  }
}

/**
 * Notion APIにツイートを送信する関数（リトライ機能付き）
 * 
 * @param {Object} tweetData - 抽出したツイートデータオブジェクト
 * @param {Object} config - 設定オブジェクト（notionApiKey, notionDatabaseId）
 * @param {number} retryCount - 現在のリトライ回数（デフォルト: 0）
 * @returns {Promise<void>} 成功時はresolve、エラー時はthrow
 */
async function sendTweetToNotionWithRetry(tweetData, config, retryCount = 0) {
  try {
    await sendTweetToNotion(tweetData, config);
  } catch (error) {
    // レート制限エラー（429）の場合は再試行
    if (error.message && error.message.includes('レート制限エラー') && retryCount < MAX_RETRY_COUNT) {
      // エラーメッセージから待機時間を抽出
      const waitTimeMatch = error.message.match(/(\d+)ms/);
      const waitTime = waitTimeMatch ? parseInt(waitTimeMatch[1], 10) : 1000;
      
      // 待機時間が有効な数値か確認
      if (!isNaN(waitTime) && waitTime > 0) {
        console.warn(`レート制限エラー: ${waitTime}ms待機後に再試行します (${retryCount + 1}/${MAX_RETRY_COUNT})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return sendTweetToNotionWithRetry(tweetData, config, retryCount + 1);
      }
    }
    // 再試行できない場合はエラーをthrow
    throw error;
  }
}

/**
 * Notion APIにツイートを送信する関数
 * 
 * @param {Object} tweetData - 抽出したツイートデータオブジェクト
 * @param {Object} config - 設定オブジェクト（notionApiKey, notionDatabaseId）
 * @returns {Promise<void>} 成功時はresolve、エラー時はthrow
 */
async function sendTweetToNotion(tweetData, config) {
  const mockMode = window.__COLLECT_MOCK_MODE__ === true;
  
  // モックモード時はAPI Keyがなくてもコンソール表示まで実行
  if (mockMode) {
    const mockConfig = {
      notionApiKey: '[REDACTED]',
      notionDatabaseId: '[MOCK_DATABASE_ID]'
    };
    
    const requestBody = buildNotionRequest(tweetData, mockConfig);
    
    console.log('=== モックモード: Notion API送信内容 ===');
    console.log('URL: https://api.notion.com/v1/pages');
    console.log('Method: POST');
    console.log('Headers:', {
      'Authorization': 'Bearer [REDACTED]',
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    });
    console.log('Body:', JSON.stringify(requestBody, null, 2));
    
    // chrome.runtime.sendMessageでMOCK_LOGメッセージを送信
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'MOCK_LOG',
        data: {
          notionRequest: {
            url: 'https://api.notion.com/v1/pages',
            method: 'POST',
            body: requestBody
          }
        }
      }).catch(() => {
        // エラーは無視
      });
    }
    
    // モックモード時はエラーをthrowしない
    return Promise.resolve({ result: 'ok', mock: true });
  }
  
  // 通常モード: 実際にNotion APIに送信
  if (!config || !config.notionApiKey || !config.notionDatabaseId) {
    throw new Error('Notion API KeyまたはDatabase IDが設定されていません');
  }
  
  const requestBody = buildNotionRequest(tweetData, config);
  
  try {
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.notionApiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      let errorMessage = `Notion APIエラー (${response.status})`;
      
      // レスポンスボディを安全に読み込む（cloneしてから読み込む）
      const responseClone = response.clone();
      try {
        const errorJson = await responseClone.json();
        if (errorJson.message) {
          errorMessage = `Notion APIエラー (${response.status}): ${errorJson.message}`;
        }
      } catch {
        // JSONパース失敗時はテキストとして取得（サイズ制限付き）
        try {
          const errorText = await response.text();
          // エラーメッセージは最大200文字に制限
          errorMessage = `Notion APIエラー (${response.status}): ${errorText.substring(0, 200)}`;
        } catch {
          // テキスト読み込みも失敗した場合はステータスコードのみ
          errorMessage = `Notion APIエラー (${response.status})`;
        }
      }
      
      // 認証エラー（401）の場合は全体を失敗としてthrow
      if (response.status === 401) {
        throw new Error('認証エラー: Notion API Keyが無効です');
      }
      
      // レート制限エラー（429）の特別処理
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        // parseIntの安全性を向上（Number.parseIntを使用し、フォールバック値を設定）
        const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : null;
        const waitTime = (retryAfterSeconds && !isNaN(retryAfterSeconds) && retryAfterSeconds > 0) 
          ? retryAfterSeconds * 1000 
          : 1000;
        throw new Error(`レート制限エラー: ${waitTime}ms後に再試行してください`);
      }
      
      // その他のAPIエラー（400等）は個別ツイートをスキップ
      throw new Error(errorMessage);
    }
    
    // 成功
    return;
  } catch (error) {
    // ネットワークエラーやその他のエラー
    if (error.message && error.message.includes('認証エラー')) {
      throw error; // 認証エラーは再throw
    }
    
    // エラータイプを判定して詳細なメッセージを生成
    let errorMessage = 'ネットワークエラー';
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      errorMessage = 'ネットワーク接続エラー: インターネット接続を確認してください';
    } else if (error.message) {
      errorMessage = `ネットワークエラー: ${error.message}`;
    }
    
    throw new Error(errorMessage);
  }
}

/**
 * Notion APIリクエストボディを構築する
 * 
 * @param {Object} tweetData - ツイートデータオブジェクト
 * @param {Object} config - 設定オブジェクト（notionDatabaseId）
 * @returns {Object} Notion APIリクエストボディ
 */
function buildNotionRequest(tweetData, config) {
  // 引用RTデータのバリデーション
  let quotedTweetBlock = null;
  if (tweetData.quotedTweet) {
    if (tweetData.quotedTweet.url && tweetData.quotedTweet.tweetId) {
      // Phase 3: 引用RTブロック（基本対応）
      // URLをリンクとして表示
      quotedTweetBlock = {
        object: 'block',
        type: 'quote',
        quote: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: tweetData.quotedTweet.url,
                link: {
                  url: tweetData.quotedTweet.url
                }
              }
            }
          ]
        }
      };
    } else {
      console.warn('引用RTデータが不完全です:', tweetData.quotedTweet);
    }
  }
  
  return {
    parent: {
      database_id: config.notionDatabaseId
    },
    properties: {
      'Tweet ID': {
        rich_text: [{
          text: {
            content: tweetData.tweetId
          }
        }]
      },
      'URL': {
        url: tweetData.url
      },
      'Text': {
        rich_text: [{
          text: {
            content: tweetData.text || ''
          }
        }]
      },
      'Author': {
        rich_text: [{
          text: {
            content: `${tweetData.author.displayName} (@${tweetData.author.screenName})`
          }
        }]
      },
      'Posted At': {
        date: {
          start: tweetData.postedAt
        }
      }
    },
    children: [
      // Phase 3: 引用RTブロック（基本対応）
      ...(quotedTweetBlock ? [quotedTweetBlock] : []),
      // Phase 5で画像ブロックを追加
    ]
  };
}
