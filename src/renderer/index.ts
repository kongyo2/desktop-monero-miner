import { z } from 'zod';

import {
  type Locale,
  type MinerConfig,
  type MiningStats,
  type MiningStatus,
  minerConfigSchema,
} from '../shared/config-schema.ts';
import type { MiningStateUpdate } from '../shared/ipc.ts';
import { formatHashrate, formatInteger, requireElement } from './dom.ts';
import { I18n, detectInitialLocale } from './i18n.ts';

import './global.d.ts';

const SOURCE_URL = 'https://github.com/kongyo2/desktop-monero-miner';

type FieldName = 'walletAddress' | 'workerId' | 'pool' | 'threads' | 'throttle' | 'password';

/**
 * Form defaults used to pre-fill the UI on first launch. Wallet address is
 * intentionally empty so the user is forced to supply their own — pre-filling
 * a synthetic address would silently direct mining to an unusable destination.
 * 初回起動時のフォーム既定値。walletAddress は意図的に空にし、必ずユーザー自身に
 * 入力させます（疑似アドレスを入れると採掘先が不達となり電力を浪費するため）。
 */
type FormValues = Record<FieldName, string | number> & {
  walletAddress: string;
  workerId: string;
  pool: string;
  threads: number;
  throttle: number;
  password: string;
};

const FORM_DEFAULTS: FormValues = {
  walletAddress: '',
  workerId: 'Desktop-Miner',
  // Default Stratum endpoint: moneroocean.stream auto-diff port.
  // Format is "host:port" or "host:port:tls". xmrig speaks Stratum directly.
  // 既定の Stratum エンドポイント。"host:port" または "host:port:tls" 形式で xmrig に渡る。
  pool: 'gulf.moneroocean.stream:10128',
  threads: 2,
  throttle: 20,
  password: '',
};

class App {
  private readonly i18n: I18n;
  private autoStart = false;
  private toastTimer: number | null = null;
  private status: MiningStatus = 'idle';
  private stats: MiningStats = emptyStats();

  public constructor(locale: Locale) {
    this.i18n = new I18n(locale);
  }

  public async initialize(): Promise<void> {
    const [persistedConfig, prefs, version] = await Promise.all([
      window.miner.getConfig(),
      window.miner.getPreferences(),
      window.miner.appVersion(),
    ]);

    this.i18n.setLocale(prefs.locale);
    this.autoStart = prefs.autoStart;

    const merged: FormValues = {
      walletAddress: persistedConfig.walletAddress ?? FORM_DEFAULTS.walletAddress,
      workerId: persistedConfig.workerId ?? FORM_DEFAULTS.workerId,
      pool: persistedConfig.pool ?? FORM_DEFAULTS.pool,
      threads: persistedConfig.threads ?? FORM_DEFAULTS.threads,
      throttle: persistedConfig.throttle ?? FORM_DEFAULTS.throttle,
      password: persistedConfig.password ?? FORM_DEFAULTS.password,
    };
    const parsed = minerConfigSchema.safeParse(merged);

    this.fillForm(merged);
    this.renderVersion(version);
    this.bindLanguage();
    this.bindForm();
    this.bindActions();
    this.bindStateUpdates();
    this.applyLocaleStrings();
    this.i18n.onChange(() => this.applyLocaleStrings());

    if (this.autoStart && parsed.success) {
      void this.startMining(parsed.data);
    }
  }

  private bindLanguage(): void {
    const select = requireElement<HTMLSelectElement>('lang-select');
    select.value = this.i18n.getLocale();
    select.addEventListener('change', () => {
      const next = select.value === 'en' ? 'en' : 'ja';
      this.i18n.setLocale(next);
      void window.miner.setPreferences({ locale: next });
    });
  }

  private bindForm(): void {
    const form = requireElement<HTMLFormElement>('config-form');
    const autostart = requireElement<HTMLInputElement>('field-autostart');
    autostart.checked = this.autoStart;
    autostart.addEventListener('change', () => {
      this.autoStart = autostart.checked;
      void window.miner.setPreferences({ autoStart: autostart.checked });
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const config = this.readForm();
      if (!config) return;
      void window.miner.setConfig(config).then(() => {
        this.showToast(this.i18n.messages().toastSaved, 'success');
      });
    });
  }

  private bindActions(): void {
    requireElement<HTMLButtonElement>('btn-start').addEventListener('click', () => {
      const config = this.readForm();
      if (!config) return;
      void this.startMining(config);
    });

    requireElement<HTMLButtonElement>('btn-stop').addEventListener('click', () => {
      void window.miner.stopMining();
      this.showToast(this.i18n.messages().toastStopped, 'success');
    });

    requireElement<HTMLButtonElement>('btn-reset').addEventListener('click', () => {
      void window.miner.resetStats();
    });

    requireElement<HTMLButtonElement>('btn-open-source').addEventListener('click', () => {
      void window.miner.openExternal(SOURCE_URL);
    });
  }

  private bindStateUpdates(): void {
    window.miner.onStateUpdate((update) => this.applyUpdate(update));
    // Subscribe first, then pull the current snapshot — without this, a
    // renderer that attaches mid-session (e.g. while xmrig is starting or
    // already mining) stays on 'idle' until the next status transition.
    // Subscribe を先に行ってから snapshot を取得し、間に発火したイベントを取り逃さない。
    void window.miner.getMiningState().then((update) => this.applyUpdate(update));
  }

  private async startMining(config: MinerConfig): Promise<void> {
    try {
      await window.miner.setConfig(config);
      await window.miner.startMining(config);
    } catch (cause) {
      console.error('[renderer] startMining failed:', cause);
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.showToast(`${this.i18n.messages().toastStartFailed}: ${detail}`, 'error');
    }
  }

  private readForm(): MinerConfig | null {
    const raw: Record<FieldName, unknown> = {
      walletAddress: this.fieldValue('field-wallet'),
      workerId: this.fieldValue('field-worker'),
      pool: this.fieldValue('field-pool'),
      threads: numberFromValue(this.fieldValue('field-threads')),
      throttle: numberFromValue(this.fieldValue('field-throttle')),
      // Pool passwords are opaque credentials — whitespace can be significant,
      // so read the raw value without trimming.
      // プールパスワードは不透明な認証情報のため、空白文字を保持して trim しない。
      password: this.rawFieldValue('field-password'),
    };

    this.clearErrors();
    const result = minerConfigSchema.safeParse(raw);
    if (!result.success) {
      this.showZodErrors(result.error);
      this.showToast(this.i18n.messages().toastValidationFailed, 'error');
      return null;
    }
    return result.data;
  }

  private fillForm(values: FormValues): void {
    setInputValue('field-wallet', values.walletAddress);
    setInputValue('field-worker', values.workerId);
    setInputValue('field-pool', values.pool);
    setInputValue('field-threads', String(values.threads));
    setInputValue('field-throttle', String(values.throttle));
    setInputValue('field-password', values.password);
  }

  private fieldValue(id: string): string {
    return requireElement<HTMLInputElement>(id).value.trim();
  }

  private rawFieldValue(id: string): string {
    return requireElement<HTMLInputElement>(id).value;
  }

  private clearErrors(): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-error-for]')) {
      el.textContent = '';
    }
  }

  private showZodErrors(error: z.ZodError): void {
    for (const issue of error.issues) {
      const [field] = issue.path;
      if (typeof field !== 'string') continue;
      const target = document.querySelector<HTMLElement>(`[data-error-for="${field}"]`);
      if (!target) continue;
      const code = this.i18n.translateError(issue.message);
      target.textContent = code || issue.message;
    }
  }

  private renderVersion(version: string): void {
    requireElement<HTMLElement>('version-value').textContent = version;
  }

  private applyLocaleStrings(): void {
    const m = this.i18n.messages();
    document.documentElement.lang = this.i18n.getLocale();
    document.title = m.appTitle;
    requireElement<HTMLElement>('app-title').textContent = m.appTitle;
    requireElement<HTMLElement>('app-tagline').textContent = m.tagline;
    requireElement<HTMLElement>('lang-label').textContent = m.language;

    requireElement<HTMLElement>('section-status-title').textContent = m.sectionStatus;
    requireElement<HTMLElement>('section-config-title').textContent = m.sectionConfig;
    requireElement<HTMLElement>('section-about-title').textContent = m.sectionAbout;

    requireElement<HTMLElement>('label-wallet').textContent = m.fieldWallet;
    requireElement<HTMLElement>('help-wallet').textContent = m.fieldWalletHelp;
    requireElement<HTMLElement>('label-worker').textContent = m.fieldWorkerId;
    requireElement<HTMLElement>('label-pool').textContent = m.fieldPool;
    requireElement<HTMLElement>('help-pool').textContent = m.fieldPoolHelp;
    requireElement<HTMLElement>('advanced-summary').textContent = m.advancedSummary;
    requireElement<HTMLElement>('label-threads').textContent = m.fieldThreads;
    requireElement<HTMLElement>('label-throttle').textContent = m.fieldThrottle;
    requireElement<HTMLElement>('help-throttle').textContent = m.fieldThrottleHelp;
    requireElement<HTMLElement>('label-password').textContent = m.fieldPassword;
    requireElement<HTMLElement>('label-autostart').textContent = m.fieldAutoStart;

    requireElement<HTMLElement>('btn-start').textContent = m.buttonStart;
    requireElement<HTMLElement>('btn-stop').textContent = m.buttonStop;
    requireElement<HTMLElement>('btn-save').textContent = m.buttonSave;
    requireElement<HTMLElement>('btn-reset').textContent = m.buttonReset;
    requireElement<HTMLElement>('btn-open-source').textContent = m.buttonOpenSource;

    requireElement<HTMLElement>('stat-hashrate-label').textContent = m.statHashrate;
    requireElement<HTMLElement>('stat-hashrate-unit').textContent = m.unitHashrate;
    requireElement<HTMLElement>('stat-accepted-label').textContent = m.statAccepted;
    requireElement<HTMLElement>('stat-rejected-label').textContent = m.statRejected;
    requireElement<HTMLElement>('stat-total-label').textContent = m.statTotalHashes;
    requireElement<HTMLElement>('stat-uptime-label').textContent = m.statUptime;

    requireElement<HTMLElement>('warn-mining').textContent = m.warningMining;
    requireElement<HTMLElement>('attribution-description').textContent = m.attributionDescription;
    requireElement<HTMLElement>('version-label').textContent = m.versionLabel;

    this.renderState();
  }

  private applyUpdate(update: MiningStateUpdate): void {
    this.status = update.status;
    if (update.stats) this.stats = update.stats;
    this.renderState(update.message);
  }

  private renderState(messageOverride?: string): void {
    const m = this.i18n.messages();
    const status = this.status;
    const statusText = statusToText(status, m);
    requireElement<HTMLElement>('status-text').textContent = statusText;

    const dot = requireElement<HTMLElement>('status-dot');
    dot.className = `dot dot--${status}`;

    const startBtn = requireElement<HTMLButtonElement>('btn-start');
    const stopBtn = requireElement<HTMLButtonElement>('btn-stop');
    const running = status === 'running' || status === 'starting';
    startBtn.disabled = running;
    stopBtn.disabled = !running;

    const stats = this.stats;
    requireElement<HTMLElement>('stat-hashrate').textContent = formatHashrate(
      stats.hashrate,
      '',
    ).trim();
    requireElement<HTMLElement>('stat-accepted').textContent = formatInteger(stats.acceptedShares);
    requireElement<HTMLElement>('stat-rejected').textContent = formatInteger(stats.rejectedShares);
    requireElement<HTMLElement>('stat-total').textContent = formatInteger(stats.totalHashes);
    const { hours, minutes, seconds } = splitDuration(stats.uptimeSec);
    requireElement<HTMLElement>('stat-uptime').textContent = m.unitDuration(
      hours,
      minutes,
      seconds,
    );

    if (messageOverride !== undefined && messageOverride !== '') {
      this.showToast(messageOverride, status === 'error' ? 'error' : 'success');
    }
  }

  private showToast(text: string, kind: 'success' | 'error' = 'success'): void {
    const el = requireElement<HTMLElement>('toast');
    el.textContent = text;
    el.classList.remove('toast--success', 'toast--error');
    el.classList.add(`toast--${kind}`, 'is-visible');
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.classList.remove('is-visible');
    }, 4000);
  }
}

function emptyStats(): MiningStats {
  return {
    hashrate: 0,
    acceptedShares: 0,
    rejectedShares: 0,
    totalHashes: 0,
    uptimeSec: 0,
  };
}

function setInputValue(id: string, value: string): void {
  requireElement<HTMLInputElement>(id).value = value;
}

function numberFromValue(value: string): number {
  // Empty input must not silently coerce to 0 — Number('') is 0 which would
  // pass `z.number().int().min(0)` and silently mean "0% throttle / 0 threads".
  // Empty 入力を 0 に解釈してしまうと、ユーザーが空欄にしただけで
  // throttle=0（全力採掘）として保存・起動されてしまうため NaN を返す。
  if (value === '') return Number.NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

function splitDuration(totalSeconds: number): {
  hours: number;
  minutes: number;
  seconds: number;
} {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return { hours, minutes, seconds };
}

function statusToText(status: MiningStatus, m: ReturnType<I18n['messages']>): string {
  switch (status) {
    case 'idle':
      return m.statusIdle;
    case 'starting':
      return m.statusStarting;
    case 'running':
      return m.statusRunning;
    case 'stopping':
      return m.statusStopping;
    case 'error':
      return m.statusError;
  }
}

async function bootstrap(): Promise<void> {
  const prefs = await window.miner.getPreferences().catch(() => ({
    locale: undefined as Locale | undefined,
    autoStart: false,
  }));
  const locale = detectInitialLocale(prefs.locale ?? undefined);
  const app = new App(locale);
  await app.initialize();
}

document.addEventListener('DOMContentLoaded', () => {
  void bootstrap();
});
