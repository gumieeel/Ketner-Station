import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeConfig, sanitizeConfig } from '../shared/config-defaults';
import type { Config, PublicConfig } from '../shared/types';

type Listener = (config: Config) => void;

function atomicWrite(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class ConfigStore {
  private config: Config = DEFAULT_CONFIG;
  private apiKey: string | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly configFile = path.join(app.getPath('userData'), 'config.json');
  private readonly secretFile = path.join(app.getPath('userData'), 'secret.bin');

  load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8')) as unknown;
      this.config = sanitizeConfig(mergeConfig(DEFAULT_CONFIG, raw));
    } catch {
      this.config = DEFAULT_CONFIG;
    }
    this.apiKey = this.readSecret() ?? process.env['KETNER_API_KEY']?.trim() ?? null;
  }

  get(): Config {
    return this.config;
  }

  getPublic(): PublicConfig {
    return { ...this.config, hasApiKey: Boolean(this.apiKey) };
  }

  getApiKey(): string | null {
    return this.apiKey;
  }

  update(patch: unknown): Config {
    this.config = sanitizeConfig(mergeConfig(this.config, patch));
    atomicWrite(this.configFile, JSON.stringify(this.config, null, 2));
    for (const listener of this.listeners) listener(this.config);
    return this.config;
  }

  setApiKey(key: string): void {
    const trimmed = key.trim();
    this.apiKey = trimmed || null;
    if (!trimmed) {
      fs.rmSync(this.secretFile, { force: true });
    } else if (safeStorage.isEncryptionAvailable()) {
      atomicWrite(this.secretFile, safeStorage.encryptString(trimmed));
    } else {
      // Шифрование недоступно (редкий случай вне Windows): храним только в памяти.
      fs.rmSync(this.secretFile, { force: true });
    }
    for (const listener of this.listeners) listener(this.config);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readSecret(): string | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(fs.readFileSync(this.secretFile)) || null;
    } catch {
      return null;
    }
  }
}
