const X_ARTICLE_LOG_PREFIX = '[サイト巡回] x-bookmarks article';

async function collect_x_article() {
  console.log(`${X_ARTICLE_LOG_PREFIX} 取得開始`);

  // TODO: X内記事ページのDOMを実ページで確認して実装する。
  // 要件:
  // - Xブックマーク内のポストにX内記事が貼られている場合、その記事ページを別タブで開いて本文を取得する。
  // - 取得対象は url / title / bodyText / author / publishedAt。
  // - 記事本文取得に失敗しても、元ポストのChatGPT送信は続行する。
  // - 失敗時は ok:false と error を返し、ChatGPT本文には「X内記事本文取得失敗」とURLを入れる。
  // - DOMを推測して壊れやすい実装を入れない。実ページ確認後にセレクタを確定する。
  // 実ページで確認する操作:
  // 1. Xブックマーク内のX内記事カードを開く。
  // 2. 記事ページのタイトル、本文、著者、投稿日がどの要素に出るかDevToolsで確認する。
  // 3. data-testid / role / aria-label / articleタグの有無を確認する。
  // 4. 記事本文がクライアント描画で遅れて出る場合、MutationObserverまたは待機条件を決める。
  // 5. ログイン切れや記事削除時のDOMも確認する。
  return {
    url: window.location.href,
    ok: false,
    error: 'TODO: X内記事ページのDOM確認後に本文取得を実装する'
  };
}
