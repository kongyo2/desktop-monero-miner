declare global {
  type StartMiningFn = (
    pool: string,
    walletAddress: string,
    workerId: string,
    threads: number,
    password: string,
  ) => void;

  type StopMiningFn = () => void;

  type GetHashesPerSecondFn = () => number;
  type GetTotalHashesFn = () => number;
  type GetAcceptedHashesFn = () => number;
  type GetRejectedHashesFn = () => number;

  // Globals populated by https://cdn.jsdelivr.net/gh/NajmAjmal/monero-webminer@main/script.js
  // 上記スクリプトが renderer 上で生成するグローバル定義。
  // eslint-disable-next-line vars-on-top, no-var
  var server: string | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var pool: string | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var walletAddress: string | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var workerId: string | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var threads: number | string | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var password: string | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var throttleMiner: number | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var startMining: StartMiningFn | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var stopMining: StopMiningFn | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var getHashesPerSecond: GetHashesPerSecondFn | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var getTotalHashes: GetTotalHashesFn | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var getAcceptedHashes: GetAcceptedHashesFn | undefined;
  // eslint-disable-next-line vars-on-top, no-var
  var getRejectedHashes: GetRejectedHashesFn | undefined;
}

export {};
