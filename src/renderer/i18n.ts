import type { Locale } from '../shared/config-schema.ts';
import { en } from './locales/en.ts';
import { ja } from './locales/ja.ts';
import type { Messages } from './locales/types.ts';

const dictionaries: Record<Locale, Messages> = { ja, en };

export class I18n {
  private locale: Locale;
  private listeners = new Set<(locale: Locale) => void>();

  public constructor(initial: Locale) {
    this.locale = initial;
  }

  public getLocale(): Locale {
    return this.locale;
  }

  public setLocale(next: Locale): void {
    if (this.locale === next) return;
    this.locale = next;
    document.documentElement.lang = next;
    for (const listener of this.listeners) listener(next);
  }

  public onChange(listener: (locale: Locale) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public messages(): Messages {
    return dictionaries[this.locale];
  }

  public translateError(code: string | undefined): string {
    if (code === undefined) return '';
    const m = this.messages();
    switch (code) {
      case 'wallet_address_invalid':
        return m.errorWalletInvalid;
      case 'wallet_address_invalid_length':
        return m.errorWalletInvalidLength;
      case 'websocket_url_invalid_scheme':
        return m.errorWebsocketInvalid;
      default:
        return code;
    }
  }
}

export function detectInitialLocale(persisted: Locale | undefined): Locale {
  if (persisted) return persisted;
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'en') ?? 'en';
  return nav.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}
