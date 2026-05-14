# Desktop Monero Miner

[![CI](https://github.com/kongyo2/desktop-monero-miner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kongyo2/desktop-monero-miner/actions/workflows/ci.yml)
[![Release](https://github.com/kongyo2/desktop-monero-miner/actions/workflows/release.yml/badge.svg)](https://github.com/kongyo2/desktop-monero-miner/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E=20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Code style: Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/kongyo2/desktop-monero-miner)

デスクトップ向け Monero (XMR) マイナーです。Electron 上に xmrig を内蔵した GUI フロントエンドで、
ウォレットアドレスとプールを設定するだけで本物の RandomX 採掘が始まります。

採掘エンジンには [xmrig](https://github.com/xmrig/xmrig) を採用しており、初回起動時に
GitHub Releases から OS / アーキテクチャに合わせたバイナリを自動でダウンロードします
（`XMRIG_BIN` 環境変数か PATH 上の xmrig が見つかればそちらを優先します）。

### 必要環境

- Node.js 20 以上
- npm 10 以上
- 初回起動時のみインターネット接続（xmrig バイナリ取得用）

### 使い方

1. `npm install`
2. `npm start` で開発起動、もしくは `npm run package` で配布物を作成
3. 起動後、ウォレットアドレス（4/8 から始まる 95 または 106 文字）と任意のワーカー ID を入力
4. プールはデフォルトで `gulf.moneroocean.stream:10128`。`host:port:tls` で TLS にも対応

### 参照プロジェクト

- [xmrig/xmrig](https://github.com/xmrig/xmrig) — 採掘エンジン

### ライセンス

MIT
