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
  // Phase 1: ツイート抽出とモックモードログ出力のみ
  
  // 1. DOMから全ツイート要素を取得
  const tweetElements = extractTweetElements();
  
  if (tweetElements.length === 0) {
    console.warn('ツイート要素が見つかりませんでした');
    return { tweets: [] };
  }
  
  // 2. 各ツイートから基本情報を抽出
  const tweets = [];
  for (const element of tweetElements) {
    try {
      const tweetData = extractTweetBasicData(element);
      if (tweetData) {
        tweets.push(tweetData);
      }
    } catch (error) {
      console.warn('ツイート抽出エラー:', error);
      // 個別ツイートのエラーはスキップして続行
    }
  }
  
  // 3. 設定を取得（モックモード時はAPI KeyがなくてもOK）
  const mockMode = window.__COLLECT_MOCK_MODE__ === true;
  let config = null;
  
  if (!mockMode) {
    // 設定を取得
    const result = await chrome.storage.local.get('settings');
    const settings = result.settings || {};
    const siteSettings = settings.sites?.['x-bookmarks'] || {};
    
    const notionApiKey = siteSettings.notionApiKey;
    const notionDatabaseId = siteSettings.notionDatabaseId;
    
    if (!notionApiKey || !notionDatabaseId) {
      throw new Error('Notion API KeyまたはDatabase IDが設定されていません');
    }
    
    config = {
      notionApiKey,
      notionDatabaseId
    };
  }
  
  // 4. モックモード時はログ出力のみ、通常モード時はNotion APIに送信
  if (mockMode) {
    // モックモード: ログ出力のみ
    mockModeLogging(tweets, null);
  } else {
    // 通常モード: Notion APIに送信
    for (const tweet of tweets) {
      try {
        await sendTweetToNotion(tweet, config);
        // レート制限対応: 350ms待機
        await new Promise(resolve => setTimeout(resolve, 350));
      } catch (error) {
        // 認証エラー（401）の場合は全体を失敗としてthrow
        if (error.message && error.message.includes('認証エラー')) {
          throw error;
        }
        // その他のエラーは個別ツイートをスキップして続行
        console.warn('ツイート送信エラー:', error.message);
      }
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
  
  return {
    tweetId,
    url,
    text,
    author,
    postedAt
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
    return `https://x.com/${screenName}/status/${tweetId}`;
  }
  // スクリーンネームが取得できない場合はIDのみ
  return `https://x.com/i/web/status/${tweetId}`;
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
  // @username形式のリンクから抽出
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
      return datetime;
    }
  }
  // 日時が取得できない場合は現在時刻を使用
  return new Date().toISOString();
}

/**
 * モックモード時のログ出力機能
 * 
 * @param {Array<Object>} tweets - 抽出したツイートデータの配列
 * @param {Object|null} config - 設定オブジェクト（モックモード時はnull）
 */
function mockModeLogging(tweets, config) {
  console.log('=== モックモード: ツイート抽出結果 ===');
  console.log(`抽出ツイート数: ${tweets.length}`);
  
  for (let i = 0; i < tweets.length; i++) {
    const tweet = tweets[i];
    console.log(`\n--- ツイート ${i + 1} ---`);
    console.log(`Tweet ID: ${tweet.tweetId}`);
    console.log(`URL: ${tweet.url}`);
    console.log(`Text: ${tweet.text.substring(0, 100)}${tweet.text.length > 100 ? '...' : ''}`);
    console.log(`Author: ${tweet.author.displayName} (@${tweet.author.screenName})`);
    console.log(`Posted At: ${tweet.postedAt}`);
  }
  
  // chrome.runtime.sendMessageでMOCK_LOGメッセージを送信
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({
      type: 'MOCK_LOG',
      data: {
        tweets: tweets.map(t => ({
          tweetId: t.tweetId,
          url: t.url,
          text: t.text.substring(0, 200), // 長いテキストは切り詰め
          author: t.author,
          postedAt: t.postedAt
        }))
      }
    }).catch(() => {
      // エラーは無視（モックモードなので）
    });
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
      notionDatabaseId: config?.notionDatabaseId || '[NOT SET]'
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
      const errorText = await response.text();
      
      // 認証エラー（401）の場合は全体を失敗としてthrow
      if (response.status === 401) {
        throw new Error('認証エラー: Notion API Keyが無効です');
      }
      
      // その他のAPIエラー（400, 429等）は個別ツイートをスキップ
      throw new Error(`Notion APIエラー (${response.status}): ${errorText.substring(0, 200)}`);
    }
    
    // 成功
    return;
  } catch (error) {
    // ネットワークエラーやその他のエラー
    if (error.message && error.message.includes('認証エラー')) {
      throw error; // 認証エラーは再throw
    }
    throw new Error(`ネットワークエラー: ${error.message}`);
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
      // Phase 3以降で画像ブロックや引用RTブロックを追加
    ]
  };
}
