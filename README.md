# Desktop Monero Miner

[日本語](#日本語) | [English](#english)

---

## 日本語

Electron + TypeScript + Zod で構築したデスクトップ向け Monero (XMR) マイナーです。
[PYU224 氏の peertube-plugin-monero-miner](https://github.com/PYU224/peertube-plugin-monero-miner)
を参考に、PeerTube プラグインとして提供されていた採掘ロジックをデスクトップアプリへ移植しました。
バックエンドの採掘スクリプトは
[NajmAjmal/monero-webminer](https://github.com/NajmAjmal/monero-webminer)
を Renderer プロセスから読み込んで動作します。

### 機能

- Monero ウォレットアドレス・プール・スレッド数・スロットルなどを GUI から設定
- `electron-store` による設定の永続化
- Zod による入力値・IPC ペイロードの厳密な検証
- 日本語 / 英語の i18n
- セキュア構成（`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`）

### 必要環境

- Node.js 20 以上
- npm 10 以上

### セットアップ

```bash
npm install
npm run build
npm start
```

### スクリプト

| コマンド                       | 説明                                             |
| ------------------------------ | ------------------------------------------------ |
| `npm run build`                | esbuild で main / preload / renderer をビルド    |
| `npm run build:watch`          | ウォッチモードでビルド                           |
| `npm start`                    | ビルドして Electron を起動                       |
| `npm run dev`                  | ビルドして Electron を `--enable-logging` で起動 |
| `npm run typecheck`            | `tsc --noEmit` で型検査                          |
| `npm run lint`                 | Oxlint を実行                                    |
| `npm run lint:strict`          | 警告も許容しない厳格な lint                      |
| `npm run format`               | Prettier で整形                                  |
| `npm run format:check`         | フォーマット確認                                 |
| `npm run check`                | 型検査 + 厳格 lint + フォーマット確認            |
| `npm run check:file -- <path>` | 指定ファイルだけ lint                            |

### ディレクトリ構成

```
src/
├── main/        # Electron メインプロセス
├── preload/     # contextBridge 経由の安全な公開 API
├── renderer/    # UI (HTML/CSS/TS), i18n, WebMiner ラッパ
└── shared/      # Zod スキーマ・IPC 定義など
scripts/
└── build.mjs    # esbuild のビルドスクリプト
```

### 設定項目

| 項目            | 既定値                         | 説明                                 |
| --------------- | ------------------------------ | ------------------------------------ |
| `walletAddress` | (空)                           | 4 / 8 で始まる Monero アドレス。必須 |
| `workerId`      | `Desktop-Miner`                | プールで表示されるワーカー名         |
| `pool`          | `moneroocean.stream`           | プールホスト名                       |
| `webSocket`     | `wss://ny1.xmrminingproxy.com` | WebSocket プロキシ                   |
| `threads`       | `2`                            | 同時実行スレッド数 (1〜256)          |
| `throttle`      | `20`                           | スロットル (0〜99、0 = 全力)         |
| `password`      | `""`                           | プールのパスワード                   |

### セキュリティと注意事項

- 本アプリは renderer プロセスで Web Worker を多数起動して CPU 採掘を行います。**実行中は CPU 使用率が大幅に上昇します**。電気代や発熱、デバイスの寿命に十分注意してください。
- 採掘スクリプトはセキュリティソフトに「不正なマイナー」と検出される事があります。これは挙動が一般的な悪意ある cryptojacking と類似しているためです。
- 自分の所有しないハードウェアでの利用は禁止されている場合があります。利用先のポリシーに従ってください。
- Renderer の CSP では `https://cdn.jsdelivr.net` からのスクリプト読込・`wss:` への接続を許可しています。

### 参照プロジェクト

- [PYU224/peertube-plugin-monero-miner](https://github.com/PYU224/peertube-plugin-monero-miner)
- [NajmAjmal/monero-webminer](https://github.com/NajmAjmal/monero-webminer)

### ライセンス

MIT

---

## English

A desktop Monero (XMR) miner built with Electron, TypeScript and Zod.
The project ports the mining flow from
[PYU224 / peertube-plugin-monero-miner](https://github.com/PYU224/peertube-plugin-monero-miner)
— originally a PeerTube plugin — into a stand‑alone Electron application,
and runs the underlying mining script
[NajmAjmal / monero-webminer](https://github.com/NajmAjmal/monero-webminer)
inside the Electron renderer.

### Features

- GUI configuration of wallet, pool, threads, throttle and more
- Persistent storage via `electron-store`
- Strict input / IPC validation through Zod
- Japanese / English i18n
- Secure defaults (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`)

### Requirements

- Node.js 20 or newer
- npm 10 or newer

### Quick start

```bash
npm install
npm run build
npm start
```

### Scripts

| Command                        | Description                                       |
| ------------------------------ | ------------------------------------------------- |
| `npm run build`                | Bundle main / preload / renderer with esbuild     |
| `npm run build:watch`          | esbuild watch mode                                |
| `npm start`                    | Build and launch Electron                         |
| `npm run dev`                  | Build and launch Electron with `--enable-logging` |
| `npm run typecheck`            | Type-check with `tsc --noEmit`                    |
| `npm run lint`                 | Run Oxlint                                        |
| `npm run lint:strict`          | Run Oxlint with `--deny-warnings`                 |
| `npm run format`               | Run Prettier                                      |
| `npm run format:check`         | Run Prettier in check mode                        |
| `npm run check`                | typecheck + strict lint + format check            |
| `npm run check:file -- <path>` | Lint a single file                                |

### Project layout

```
src/
├── main/        # Electron main process
├── preload/     # Safe API surface via contextBridge
├── renderer/    # UI (HTML/CSS/TS), i18n, WebMiner wrapper
└── shared/      # Zod schemas and IPC types shared by all processes
scripts/
└── build.mjs    # esbuild bundling script
```

### Configuration

| Key             | Default                        | Description                                    |
| --------------- | ------------------------------ | ---------------------------------------------- |
| `walletAddress` | (empty)                        | Monero address starting with 4 or 8. Required. |
| `workerId`      | `Desktop-Miner`                | Worker name shown on the pool.                 |
| `pool`          | `moneroocean.stream`           | Pool host.                                     |
| `webSocket`     | `wss://ny1.xmrminingproxy.com` | WebSocket proxy.                               |
| `threads`       | `2`                            | Concurrent worker threads (1–256).             |
| `throttle`      | `20`                           | Throttle 0–99 (0 = full speed).                |
| `password`      | `""`                           | Optional pool password.                        |

### Security notes

- Mining uses many Web Workers in the renderer process. **CPU usage will be very high while mining**. Watch your electricity bill, fan / heat and battery.
- Anti-virus software may flag the bundled mining script as a crypto-jacker because the runtime behaviour is similar.
- Do not run on hardware you do not own. Always follow the terms of service for the device or platform you use.
- The renderer CSP allows scripts from `https://cdn.jsdelivr.net` and connections to `wss:` / `https:` endpoints.

### Credits

- [PYU224/peertube-plugin-monero-miner](https://github.com/PYU224/peertube-plugin-monero-miner) — original PeerTube plugin we used as a reference.
- [NajmAjmal/monero-webminer](https://github.com/NajmAjmal/monero-webminer) — the underlying WebAssembly mining script.

### License

MIT
