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

function slackWebhookFromSiteOrGlobal(site, settings) {
  const s = (site?.slackWebhookUrl || '').trim();
  if (s) return s;
  return (settings?.slackWebhookUrl || '').trim();
}

async function persistSiteRunFailure(siteId, settings, site, now, error) {
  const currentState = await chrome.storage.local.get('state');
  if (!currentState.state) currentState.state = { bySite: {} };
  if (!currentState.state.bySite) currentState.state.bySite = {};
  const currentSiteState = currentState.state.bySite[siteId] || {};
  let errorMessage = error.message || String(error);
  errorMessage = errorMessage.replace(/password|token|secret|key|api[_-]?key/gi, '[REDACTED]');
  errorMessage = errorMessage.substring(0, 100);
  const failCount = (currentSiteState.failCount || 0) + 1;
  currentState.state.bySite[siteId] = {
    ...currentSiteState,
    nextRun: computeNextRunAfterFail(now),
    lastStatus: 'fail',
    failCount,
    lastRun: now,
    lastError: errorMessage
  };
  await chrome.storage.local.set({ state: currentState.state });
  const hook = slackWebhookFromSiteOrGlobal(site, settings);
  if (hook) {
    await notifySlackOnFailure(hook, {
      siteId,
      error: errorMessage,
      failCount
    });
  }
}

function waitUntilTabComplete(tabId, timeoutSec) {
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
    chrome.tabs
      .get(tabId)
      .then((tabInfo) => {
        if (tabInfo.status === 'complete' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      })
      .catch(() => {});
  });
}

function assertInjectablePageUrl(tabUrl) {
  if (
    tabUrl.startsWith('chrome-extension://') ||
    tabUrl.startsWith('chrome://') ||
    tabUrl.startsWith('edge://') ||
    tabUrl.startsWith('about:') ||
    tabUrl.startsWith('data:') ||
    tabUrl.startsWith('javascript:')
  ) {
    throw new Error(`Cannot inject content script into restricted URL: ${tabUrl}`);
  }
}

/**
 * 指定タブへ sites/{site}.js と content-script を注入し COLLECT を1回実行する。
 *
 * TODO: SPA遷移後の再injectが必要になるサイトが増えたら、ここに wait 戦略または再実行フックを追加する。
 *
 * @param {number} tabId
 * @param {string} collectSiteId 例 x-bookmarks, x_article, chatgpt_project
 */
function injectAndCollect(tabId, collectSiteId, options) {
  const { mockMode = false, collectContext, timeoutSec: rawTimeout } = options;
  const timeoutSec =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 60;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        chrome.runtime.onMessage.removeListener(messageListener);
      }
    };
    const messageListener = (message, sender) => {
      if (sender.tab?.id === tabId && message.type === 'COLLECT_RESULT' && !resolved) {
        cleanup();
        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve(message.payload);
        }
      }
      return undefined;
    };
    chrome.runtime.onMessage.addListener(messageListener);
    const scriptPath = 'sites/' + collectSiteId.replace(/_/g, '-') + '.js';

    chrome.scripting
      .executeScript({
        target: { tabId },
        files: [scriptPath, 'content-script.js']
      })
      .then(() => {
        let retries = 0;
        const maxRetries = 5;
        const trySendMessage = () => {
          chrome.tabs
            .sendMessage(tabId, {
              type: 'COLLECT',
              siteId: collectSiteId,
              mockMode,
              collectContext
            })
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
                setTimeout(trySendMessage, 50);
              } else {
                cleanup();
                reject(new Error(`Failed to send message to content script: ${err.message}`));
              }
            });
        };
        setTimeout(trySendMessage, 50);
      })
      .catch((err) => {
        cleanup();
        reject(new Error(`Failed to inject content script: ${err.message}`));
      });

    setTimeout(() => {
      if (!resolved) {
        cleanup();
        reject(new Error('Content script timeout'));
      }
    }, Math.max(0, (timeoutSec - 5) * 1000));
  });
}

/** 親ポストと引用のX記事リンクを統合する（順序維持・重複除去） */
function mergeBookmarkXArticleUrls(post) {
  const out = [];
  const seen = new Set();
  const append = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const u of arr) {
      if (!u || typeof u !== 'string') continue;
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  };
  append(post?.xArticleUrls);
  append(post?.quotedPost?.xArticleUrls);
  return out;
}

function stringifyQuotedSnippet(quoted) {
  if (!quoted) return '';
  const bits = [];
  bits.push(`TweetID: ${quoted.tweetId || ''}`);
  bits.push(`URL: ${quoted.url || ''}`);
  if (quoted.author) {
    bits.push(`投稿者: ${quoted.author.displayName || ''} (@${quoted.author.screenName || ''})`);
  }
  if (quoted.postedAt) bits.push(`投稿日時: ${quoted.postedAt}`);
  bits.push('');
  bits.push(quoted.text ? quoted.text : '(本文なし / 未取得)');
  if (quoted.imageUrls?.length) bits.push('', '画像:', quoted.imageUrls.join('\n'));
  if (quoted.externalLinks?.length) bits.push('', '外部リンク:', quoted.externalLinks.join('\n'));
  if (quoted.xArticleUrls?.length) bits.push('', 'X内記事:', quoted.xArticleUrls.join('\n'));
  return bits.join('\n');
}

function fallbackTitleFromBookmarkPost(post) {
  const sn = post?.author?.screenName ? `@${post.author.screenName}` : '';
  const head =
    post?.text && post.text.trim()
      ? post.text.replace(/\s+/g, ' ').trim().slice(0, 72)
      : post?.tweetId || 'X bookmark';
  return [sn, head].filter(Boolean).join(' | ');
}

function buildXBookmarksChatgptPrompt(post, xArticleResults, promptPrefixFromSettings) {
  const prefix =
    (promptPrefixFromSettings && promptPrefixFromSettings.trim()) ||
    'このポストの内容を理解しやすいように要約・解説してください。重要な論点や前提があれば補足してください。';
  const parts = [];
  parts.push(prefix);
  parts.push('');
  parts.push('--- メインポスト ---');
  parts.push(`URL: ${post.url || ''}`);
  parts.push(`TweetID: ${post.tweetId || ''}`);
  if (post.author) {
    parts.push(`投稿者: ${post.author.displayName || ''} (@${post.author.screenName || ''})`);
  }
  if (post.postedAt) parts.push(`投稿日時(ISO): ${post.postedAt}`);
  parts.push('');
  parts.push(post.text ? `本文:\n${post.text}` : '(本文なし)');
  if (post.imageUrls?.length) {
    parts.push('', '画像メディアURL:', post.imageUrls.join('\n'));
  }
  if (post.externalLinks?.length) {
    parts.push('', '外部リンク:', post.externalLinks.join('\n'));
  }
  if (post.xArticleUrls?.length) parts.push('', 'X内記事URL（親）:', post.xArticleUrls.join('\n'));
  if (post.quotedPost) {
    parts.push('', '--- 引用元（引用の引用は収集しない） ---', stringifyQuotedSnippet(post.quotedPost));
  }
  parts.push('', '--- X記事ページ抽出結果 ---');
  if (!xArticleResults || xArticleResults.length === 0) {
    parts.push('（x-article で開くべき対象がありませんでした）');
  } else {
    for (let i = 0; i < xArticleResults.length; i++) {
      const r = xArticleResults[i];
      parts.push('', `[記事 ${i + 1}]`, `URL: ${r.url || ''}`);
      if (r.ok && r.bodyText) {
        parts.push(`タイトル: ${r.title || ''}`, `本文:\n${r.bodyText}`);
      } else {
        parts.push(`抽出失敗: ${r.error || '不明'}（sites/x-article.js のTODO/DOM確認待ちでよくある状態）`);
      }
    }
  }
  return parts.join('\n');
}

async function persistSiteRunOkMergeProcessed(siteId, site, now, processedTweetIds, opts) {
  const partialErrors = (opts && opts.partialErrors) || '';
  const gotten = await chrome.storage.local.get('state');
  const state = gotten.state && typeof gotten.state === 'object' ? gotten.state : { bySite: {} };
  if (!state.bySite) state.bySite = {};
  const prev = state.bySite[siteId] || {};
  state.bySite[siteId] = {
    ...prev,
    processedTweetIds,
    nextRun: computeNextRunAfterSuccess(now, site.schedule),
    lastStatus: 'ok',
    failCount: 0,
    lastRun: now,
    lastError: partialErrors ? partialErrors.substring(0, 100) : ''
  };
  await chrome.storage.local.set({ state });
}

/**
 * Notion 等の旧フローを廃止し、ChatGPT Project へのマルチタブパイプラインで処理する。
 * TODO: DOMまだ確認できていない箇所（x-article / chatgpt の実送信）はサイトスクリプト側のTODOのまま。
 */
async function runSiteXBookmarksPipeline(siteId, site, settings, mockMode, now) {
  try {
    const bookmarksUrl = (site.url || '').trim();
    if (
      bookmarksUrl.startsWith('chrome-extension://') ||
      bookmarksUrl.startsWith('chrome://') ||
      bookmarksUrl.startsWith('edge://') ||
      bookmarksUrl.startsWith('about:') ||
      bookmarksUrl.startsWith('data:') ||
      bookmarksUrl.startsWith('javascript:')
    ) {
      throw new Error(`Invalid URL for bookmarks page: ${bookmarksUrl}`);
    }
    const chatgptProjectUrl = (site.chatgptProjectUrl || '').trim();
    if (!chatgptProjectUrl || !isValidApiUrl(chatgptProjectUrl)) {
      throw new Error(
        'ChatGPT Project URLが未設定または不正です（サイトオプションの ChatGPT Project URL を設定してください）'
      );
    }

    const pipelineTimeoutSec =
      typeof site.timeoutSec === 'number' &&
      Number.isFinite(site.timeoutSec) &&
      site.timeoutSec > 0
        ? site.timeoutSec
        : 60;
    /** ブックマーク一覧はスクロールが長めのため、COLLECT の打ち切りだけ余裕を持たせる */
    const bookmarkCollectTimeoutSec = Math.max(pipelineTimeoutSec, 150);

    let { state } = await chrome.storage.local.get('state');
    const prevBucket = { ...(state.bySite[siteId] || {}) };
    let processedTweetIds = { ...(prevBucket.processedTweetIds || {}) };

    const bookmarksTabId = (await chrome.tabs.create({ url: bookmarksUrl, active: false })).id;
    let posts = [];
    try {
      await waitUntilTabComplete(bookmarksTabId, pipelineTimeoutSec);
      const bmTabMeta = await chrome.tabs.get(bookmarksTabId);
      assertInjectablePageUrl(bmTabMeta.url || '');
      const bmEnvelope = await injectAndCollect(bookmarksTabId, 'x-bookmarks', {
        mockMode,
        timeoutSec: bookmarkCollectTimeoutSec,
        collectContext: { processedTweetIds }
      });
      posts = (bmEnvelope.payload && bmEnvelope.payload.posts) || [];
    } finally {
      try {
        await chrome.tabs.remove(bookmarksTabId);
      } catch (_) {}
    }

    if (posts.length === 0) {
      await persistSiteRunOkMergeProcessed(siteId, site, now, processedTweetIds, { partialErrors: '' });
      console.log(`Site ${siteId} bookmark pipeline: no new posts`);
      return;
    }

    let okCount = 0;
    const errors = [];

    for (const post of posts) {
      if (!post?.tweetId) continue;
      try {
        const articleUrls = mergeBookmarkXArticleUrls(post).filter((u) => /^https?:\/\//i.test(u));

        /** @type {Array<Object>} */
        const xArticleResults = [];

        // TODO: 記事ページがクライアント描画で遅い場合は load 後のウェイトまたは MutationObserver 戦略を x-article 側またはここで追加する。

        for (const articleUrl of articleUrls) {
          const tabIdArticle = (await chrome.tabs.create({ url: articleUrl, active: false })).id;
          try {
            await waitUntilTabComplete(tabIdArticle, pipelineTimeoutSec);
            const artTab = await chrome.tabs.get(tabIdArticle);
            assertInjectablePageUrl(artTab.url || '');
            const envelope = await injectAndCollect(tabIdArticle, 'x_article', {
              mockMode,
              timeoutSec: pipelineTimeoutSec,
              collectContext: {}
            });
            xArticleResults.push(envelope.payload || {});
          } catch (e) {
            xArticleResults.push({ ok: false, error: e.message, url: articleUrl });
          } finally {
            try {
              await chrome.tabs.remove(tabIdArticle);
            } catch (_) {}
          }
        }

        const prompt = buildXBookmarksChatgptPrompt(post, xArticleResults, site.promptPrefix);
        const payloadForChatgpt = {
          post,
          xArticleResults,
          prompt,
          mockMode,
          fallbackTitle: fallbackTitleFromBookmarkPost(post)
        };

        const gptTabId = (await chrome.tabs.create({ url: chatgptProjectUrl, active: false })).id;
        try {
          await waitUntilTabComplete(gptTabId, pipelineTimeoutSec);
          const gpTabMeta = await chrome.tabs.get(gptTabId);
          assertInjectablePageUrl(gpTabMeta.url || '');
          const gptEnvelope = await injectAndCollect(gptTabId, 'chatgpt_project', {
            mockMode,
            timeoutSec: pipelineTimeoutSec,
            collectContext: { __chatgptPostPayload: payloadForChatgpt }
          });
          const gptInner = gptEnvelope.payload || {};
          if (!gptInner.ok && !gptInner.mock) {
            throw new Error(gptInner.error || 'ChatGPT 側の処理が成功しませんでした');
          }

          processedTweetIds = {
            ...processedTweetIds,
            [post.tweetId]: {
              processedAt: Date.now(),
              conversationUrl: gptInner.conversationUrl ?? null,
              title: gptInner.title ?? null
            }
          };

          ({ state } = await chrome.storage.local.get('state'));
          const pb = state.bySite[siteId] || {};
          state.bySite[siteId] = { ...pb, processedTweetIds };
          await chrome.storage.local.set({ state });

          okCount++;
        } finally {
          try {
            await chrome.tabs.remove(gptTabId);
          } catch (_) {}
        }
      } catch (postErr) {
        errors.push(`${post.tweetId}: ${postErr.message || String(postErr)}`);
        console.error(`[${siteId}] post pipeline failed`, post.tweetId, postErr);
      }
    }

    if (okCount === 0) {
      const msg =
        errors.join(' / ').substring(0, 250) ||
        '取得したすべてのポストで ChatGPT パイプラインに失敗しました';
      throw new Error(msg);
    }

    await persistSiteRunOkMergeProcessed(siteId, site, now, processedTweetIds, {
      partialErrors: errors.length ? errors.join('; ').substring(0, 200) : ''
    });

    console.log(`Site ${siteId} bookmark+chatgpt pipeline ok (${okCount}/${posts.length} posts succeeded)`);

    const apiUrlTrim = site.apiUrl && site.apiUrl.trim();
    if (apiUrlTrim) {
      // TODO: ChatGPT と併せて外向き API にも載せたい場合は送信ペイロード形式を決めて実装する（現状はスキップ）。
      console.warn(
        `[${siteId}] site.apiUrl is set but x-bookmarks pipeline skips HTTP POST until payload contract is defined.`
      );
    }
  } catch (error) {
    await persistSiteRunFailure(siteId, settings, site, now, error);
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

  if (siteId === 'x-bookmarks') {
    await runSiteXBookmarksPipeline(siteId, site, settings, mockMode, now);
    return;
  }

  let tabId = null;

  try {
    // URL検証をタブ作成前に実行（早期エラー検出）
    const siteUrl = site.url || '';
    if (
      siteUrl.startsWith('chrome-extension://') ||
      siteUrl.startsWith('chrome://') ||
      siteUrl.startsWith('edge://') ||
      siteUrl.startsWith('about:') ||
      siteUrl.startsWith('data:') ||
      siteUrl.startsWith('javascript:')
    ) {
      throw new Error(
        `Invalid URL for content script injection: ${siteUrl}. Please use a valid HTTP/HTTPS URL.`
      );
    }

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
      // 内部ネットワーク（file://, ftp://等）へのアクセスを防止
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
    // site.apiUrl が存在しない場合は、content-script 側で送信を担当（moneyforward など）
    
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
    await persistSiteRunFailure(siteId, settings, site, now, error);
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

