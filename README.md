# 挟みゲーム IN A PINCH(ブラウザ版)

`In_a_Pinch_app_5.py`(Python/tkinter版)のルール・画面構成・AIをそのまま踏襲した、
**ブラウザだけで動く**版です。ビルド不要・追加インストール不要の素のHTML/CSS/JavaScriptで
できているので、GitHub Pagesにそのまま置けばスマホでもパソコンでも遊べます。

## 収録内容(Python版との対応)

- ゲームエンジン(配置・移動・壁挟み・接触制限・挟み義務の連鎖・千日手判定)を完全移植
- 探索AI 7段階(ランダム〜神)+ テンプレート専用の最強AI「奥義」
  - AIの思考は Web Worker(裏方のスレッド)で行うので、長考中も画面は固まりません
- チュートリアル(11ページ)/ 戦略コラム(8本)/ 戦術レポート(データ付き長文)
- 対戦履歴・感想戦(棋譜の並べ直し)
  - Python版はCSVファイルとして保存していましたが、ブラウザ版は
    **この端末のブラウザ内(localStorage)** に保存します。「対戦履歴」画面から
    いつでもCSVとしてダウンロードもできます。
- オンライン対戦(「手番リンク」方式)
  - Python版はTCPで直接接続していましたが、GitHub Pagesは「サーバーの無い
    静的サイト」なので直接接続はできません。代わりに、指した手をURLに
    埋め込んで相手と送り合う **非同期の通信対局** を用意しています
    (LINEやメールでリンクを送り合うイメージです)。

## 動作確認だけしたい場合

`index.html` をダブルクリックして開くだけで、メニュー・チュートリアル・戦略コラム・
戦術レポートはそのまま見られます。AI対戦まで試したい場合は、ブラウザの制限で
Web Workerがうまく動かないことがあるため、下記のどれかで簡易サーバーを立てて
から開くことをおすすめします(公開後のGitHub Pagesでは何もしなくても動きます)。

```bash
# このフォルダの中で実行してください
python -m http.server 8080
```

実行したら `http://localhost:8080/` を開いてください。

## GitHub Pagesで公開する手順(初めての方向け)

以下はすべて無料でできます。何かの操作でつまずいたら、そのエラーメッセージで
検索すると大抵解決します。

### 1. GitHubアカウントを作る(すでにお持ちならスキップ)

https://github.com/ を開き、右上の「Sign up」からアカウントを作成してください。

### 2. 新しいリポジトリ(保管場所)を作る

1. GitHubにログインした状態で右上の「+」→「New repository」をクリック
2. Repository name に好きな名前を入力(例: `hasami-game-web`)
3. Public(公開)を選択
4. 「Add a README file」などのチェックは **入れない**(このフォルダに既にファイルがあるため)
5. 「Create repository」をクリック

作成すると `https://github.com/(あなたのユーザー名)/hasami-game-web` のようなページが
表示され、そこに `git remote add ...` から始まるコマンド例が載っています。

### 3. このフォルダをGitHubに送る

このフォルダは `git init` 済みで、ファイルは `git add` までしてありますが、
**コミット(記録の確定)はまだ行っていません**。このPCにはまだ「あなたが誰か」の
git設定が入っていなかったためです。お使いのターミナル(コマンドプロンプト/
PowerShell/ターミナル)で、この `hasami-web` フォルダに移動してから、
以下を1行ずつ実行してください(名前とメールアドレスは何でも構いません。
`(あなたのユーザー名)` と `hasami-game-web` は手順2で作った実際の値に
置き換えてください)。

```bash
git config --global user.name "あなたの名前"
git config --global user.email "you@example.com"
git commit -m "挟みゲームのブラウザ版を追加"
git branch -M main
git remote add origin https://github.com/(あなたのユーザー名)/hasami-game-web.git
git push -u origin main
```

(もしこのフォルダがまだ `git init` されていない場合は、`git config` の前に
`git init` と `git add .` を実行してください。)

`git push` の際にGitHubのユーザー名・パスワードを聞かれた場合、今のGitHubは
パスワードではなく「Personal Access Token」という専用の文字列が必要です。
聞かれたら https://github.com/settings/tokens から
「Generate new token (classic)」→ `repo` にチェック → 発行されたトークンを
パスワード欄に貼り付けてください。一度ログイン情報を保存すれば次回からは不要です。

すでに `git init` 済み(このフォルダがgitリポジトリになっている)場合は、
`git init` は省略して構いません。

### 4. GitHub Pagesを有効にする

1. GitHub上のリポジトリページで「Settings」タブを開く
2. 左メニューの「Pages」を開く
3. 「Build and deployment」の「Source」を **Deploy from a branch** にする
4. 「Branch」を **main** / フォルダを **/(root)** にして「Save」
5. 1〜2分待つと、ページ上部に
   `https://(あなたのユーザー名).github.io/hasami-game-web/` という
   URLが表示されます。これが完成した公開URLです。

このURLを開けば、スマホでもパソコンでも同じように遊べます。
URLをそのまま人に送れば、その人もブラウザだけで遊べます。

### 5. 更新したくなったら

ファイルを直したあと、同じフォルダで次を実行するだけで反映されます
(数十秒〜数分で公開ページにも反映されます)。

```bash
git add .
git commit -m "更新内容のメモ"
git push
```

## 「オンライン対戦(手番リンク)」の使い方

1. メニュー右上「🌐 オンライン対戦」を開く
2. 盤面サイズなどを決めて「対局を作ってリンクを発行」
3. 表示されたリンクをコピーして、対戦したい相手に送る(LINE・メール等)
4. 相手がリンクを開くと同じ盤面が再現され、相手の手番から続けられます
5. 手を指すたびに新しいリンクが作られるので、それを送り返し合うことで
   対局が進みます(将棋の郵便対局のようなイメージです)。

サーバーを介さずURLだけで手を交換する方式のため、常時接続や部屋番号は不要ですが、
同時に着手はできません(交互にリンクを送り合う形式です)。

## ファイル構成

| ファイル | 内容 |
|---|---|
| `index.html` | ページの土台(ほぼ空。実体は `app.js` が描画) |
| `styles.css` | 見た目(色・アニメーションなど) |
| `engine.js` | ルールエンジン(`In_a_Pinch_app_5.py` の `GameEngine` 相当) |
| `ai.js` | 探索AI(`MinimaxAI` / `TemplateSpecialistAI` 相当) |
| `ai-worker.js` | AIの思考をバックグラウンドで行うWeb Worker |
| `content.js` | チュートリアル・戦略コラム・戦術レポートの文章と定数 |
| `app.js` | 画面遷移・盤面描画・操作(アプリ本体) |
| `test_node.js` | 開発用の自動テスト(`node test_node.js` で実行。サイトには含まれません) |
