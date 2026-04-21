# 1. Puppeteer（Chrome入り）の公式イメージをベースにする
FROM ghcr.io/puppeteer/puppeteer:latest

# 2. 作業ディレクトリを作成
WORKDIR /app

# 3. 権限をrootに変更してインストール準備
USER root

# 4. 設定ファイルをコピー
COPY package*.json ./

# 5. ライブラリをインストール
RUN npm install

# 6. すべてのプログラムコードをコピー
COPY . .

# 7. 実行ユーザーを安全なユーザーに戻す
USER pptruser

# 8. ポート3000を開放
EXPOSE 3000

# 9. サーバーを起動
CMD ["node", "server.js"]