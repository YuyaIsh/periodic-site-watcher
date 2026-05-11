const CHATGPT_PROJECT_LOG_PREFIX = '[サイト巡回] x-bookmarks chatgpt';

async function collect_chatgpt_project(site = {}) {
  console.log(`${CHATGPT_PROJECT_LOG_PREFIX} 送信開始`);

  const payload = site.__chatgptPostPayload;
  if (!payload || !payload.prompt) {
    throw new Error('ChatGPT送信用payloadがありません');
  }

  // TODO: ChatGPT Projectの送信DOMを実ページで確認して実装する。
  // 要件:
  // - 対象は作成済みProject「x-bookmark」のURL。
  // - 1ポストにつき1つの新規会話を開始する。
  // - 入力する本文は「このポストの内容を解説してほしい」という依頼文を含む。
  // - ポストURL、投稿者、投稿日、本文全文、画像URL、引用ポスト、X内記事、外部リンクを含める。
  // - 画像URLは必ずプロンプト本文に残す。
  // - 可能であれば画像URLをfetchしてBlob/File化し、ChatGPT入力欄へ画像ファイルとして添付する。
  // - 画像添付に成功しても画像URLは本文に残す。
  // - 画像添付に失敗しても本文送信は続行する。
  // - 送信後、作成された会話URLとタイトルを取得する。
  // - 会話URL取得に失敗した場合はエラーにして処理済みにしない。
  // - タイトル取得に失敗した場合は fallbackTitle を使う。
  // 実ページで確認する操作:
  // 1. 作成済みProject「x-bookmark」のURLを開く。
  // 2. 新規チャット入力欄にテキストを入力する。
  // 3. 画像ファイルを手動で貼り付け、添付プレビューDOMを確認する。
  // 4. 送信ボタンを押す。
  // 5. 送信後にURLがどう変化するか確認する。
  // 6. 会話タイトルがdocument.titleか画面上のヘッダーDOMから取れるか確認する。
  // 実装候補:
  // - 入力欄: textarea または div[contenteditable="true"]。
  // - 送信: data-testid / aria-label を実ページで確認する。
  // - 画像添付: input[type="file"] / ClipboardEvent paste / DataTransfer drop のどれが使えるか検証する。
  // - URL: location.href の変化を待つ。
  // - title: document.title または会話ヘッダーDOM。
  // 失敗時の扱い:
  // - 画像添付失敗だけではエラーにしない。
  // - 本文送信失敗、会話URL取得失敗はエラーにする。
  // - エラー時はService Worker側でprocessedTweetIdsに入れない。

  console.log(`${CHATGPT_PROJECT_LOG_PREFIX} TODO送信 payload`, {
    tweetId: payload.post?.tweetId,
    postUrl: payload.post?.url,
    promptPreview: payload.prompt.slice(0, 300)
  });

  if (payload.mockMode) {
    return {
      ok: true,
      conversationUrl: 'mock://chatgpt/x-bookmark/' + encodeURIComponent(payload.post?.tweetId || 'unknown'),
      title: payload.fallbackTitle || 'Mock X Bookmark',
      attachedImageUrls: [],
      failedImageUrls: payload.post?.imageUrls || [],
      mock: true
    };
  }

  throw new Error('TODO: ChatGPT ProjectのDOM確認後に送信処理を実装する');
}
