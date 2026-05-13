declare global {
  type StartMiningFn = (
    pool: string,
    login: string,
    password: string,
    threads: number,
    userid: string,
  ) => void;

  type StopMiningFn = () => void;

  // Globals populated by https://cdn.jsdelivr.net/gh/NajmAjmal/monero-webminer@<pinned>/script.js
  // The upstream script intentionally exports onto the global scope rather
  // than a namespaced object. Only the values listed below are read or written
  // from the host application; everything else is treated as opaque.
  // 上流スクリプトはグローバルスコープに直接シンボルを定義する。アプリ側で
  // 参照・更新するのは以下に列挙したものだけで、それ以外は不透明として扱う。

  // eslint-disable-next-line vars-on-top, no-var
  var server: string | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var throttleMiner: number | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var totalhashes: number | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var sendStack: unknown[] | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var receiveStack: unknown[] | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var wasmSupported: boolean | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var startMining: StartMiningFn | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var stopMining: StopMiningFn | undefined;
}

export {};
