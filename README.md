# Desktop Monero Miner

デスクトップ向け Monero (XMR) マイナーです。
[PYU224 氏の peertube-plugin-monero-miner](https://github.com/PYU224/peertube-plugin-monero-miner)
を参考に、PeerTube プラグインとして提供されていた採掘ロジックをデスクトップアプリへ移植しました。
バックエンドの採掘スクリプトは
[NajmAjmal/monero-webminer](https://github.com/NajmAjmal/monero-webminer)
を Renderer プロセスから読み込んで動作します。

### 必要環境

- Node.js 20 以上
- npm 10 以上

### 参照プロジェクト

- [PYU224/peertube-plugin-monero-miner](https://github.com/PYU224/peertube-plugin-monero-miner)
- [NajmAjmal/monero-webminer](https://github.com/NajmAjmal/monero-webminer)

### ライセンス

MIT
