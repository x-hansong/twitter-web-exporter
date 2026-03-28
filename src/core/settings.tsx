import { Fragment } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import {
  IconSettings,
  IconBrandGithubFilled,
  IconHelp,
  IconDatabaseExport,
  IconDatabaseImport,
  IconTrashX,
  IconReportAnalytics,
  IconRefresh,
} from '@tabler/icons-preact';
import { GM_registerMenuCommand } from '$';

import packageJson from '@/../package.json';
import { Modal } from '@/components/common';
import { BatchCaptureModal } from '@/components/modals/batch-capture';
import { useTranslation, detectBrowserLanguage, LANGUAGES_CONFIG, TranslationKey } from '@/i18n';
import { capitalizeFirstLetter, cx, useToggle } from '@/utils/common';
import { saveFile } from '@/utils/exporter';

import { db } from './database';
import extensionManager from './extensions';
import { migrationManager } from './migration';
import { DEFAULT_APP_OPTIONS, options, THEMES } from './options';
import { syncManager } from './sync';

export function Settings() {
  const { t, i18n } = useTranslation();

  const currentTheme = useSignal(options.get('theme'));
  const syncEnabled = useSignal(!!options.get('syncEnabled'));
  const syncBackend = useSignal(options.get('syncBackend', 'supabase'));
  const supabaseUrl = useSignal(options.get('supabaseUrl', ''));
  const supabaseAnonKey = useSignal(options.get('supabaseAnonKey', ''));
  const minioEndpoint = useSignal(options.get('minioEndpoint', ''));
  const minioBucket = useSignal(options.get('minioBucket', ''));
  const minioRegion = useSignal(options.get('minioRegion', 'us-east-1'));
  const minioAccessKeyId = useSignal(options.get('minioAccessKeyId', ''));
  const minioSecretAccessKey = useSignal(options.get('minioSecretAccessKey', ''));
  const lzcApiAuthToken = useSignal(options.get('lzcApiAuthToken', ''));
  const importInputRef = useRef<HTMLInputElement>(null);
  const [showSettings, toggleSettings] = useToggle(false);
  const [showBatchCapture, toggleBatchCapture] = useToggle(false);

  const styles = {
    subtitle: 'mb-2 text-base-content ml-4 opacity-50 font-semibold text-xs',
    block:
      'text-sm mb-2 w-full flex px-4 py-2 text-base-content bg-base-200 rounded-box justify-between',
    item: 'label cursor-pointer flex justify-between h-8 items-center p-0',
  };

  useEffect(() => {
    GM_registerMenuCommand(`${t('Version')} ${packageJson.version}`, () => {
      window.open(packageJson.homepage, '_blank');
    });
  }, []);

  const onExportMigration = async () => {
    try {
      const blob = await migrationManager.exportPackage();
      saveFile(`twitter-web-exporter-migration-${Date.now()}.json`, blob);
      alert(t('Migration package exported.'));
    } catch (error) {
      alert(`${t('Failed to export migration package.')}\n\n${(error as Error).message}`);
    }
  };

  const onImportMigration = async (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    if (!file) {
      return;
    }

    try {
      const parsed = await migrationManager.parsePackage(file);
      const confirmed = confirm(
        [
          t(
            'Importing this migration package will overwrite your current local database and settings.',
          ),
          t(
            'The migration file contains sensitive configuration such as sync credentials and tokens.',
          ),
          t('Your browser will reload after a successful import.'),
          '',
          `${t('Exported at')}: ${parsed.exportedAt}`,
          `${t('App Version')}: ${parsed.appVersion}`,
          '',
          t('Do you want to continue?'),
        ].join('\n'),
      );

      if (!confirmed) {
        return;
      }

      await migrationManager.importPackage(file);
      alert(t('Migration package imported. The page will now reload.'));
      window.location.reload();
    } catch (error) {
      alert(`${t('Failed to import migration package.')}\n\n${(error as Error).message}`);
    }
  };

  return (
    <Fragment>
      {/* Settings button. */}
      <div
        onClick={toggleSettings}
        class="w-9 h-9 mr-2 cursor-pointer flex justify-center items-center transition-colors duration-200 rounded-full hover:bg-base-200"
      >
        <IconSettings />
      </div>
      {/* Settings modal. */}
      <Modal title={t('Settings')} show={showSettings} onClose={toggleSettings} class="max-w-lg">
        {/* Common settings. */}
        <p class={styles.subtitle}>{t('General')}</p>
        <div class={cx(styles.block, 'flex-col')}>
          <label class={styles.item}>
            <span class="label-text whitespace-nowrap">{t('Theme')}</span>
            <select
              class="select select-xs"
              onChange={(e) => {
                currentTheme.value =
                  (e.target as HTMLSelectElement)?.value ?? DEFAULT_APP_OPTIONS.theme;
                options.set('theme', currentTheme.value);
              }}
            >
              {THEMES.map((theme) => (
                <option key={theme} value={theme} selected={currentTheme.value === theme}>
                  {capitalizeFirstLetter(theme)}
                </option>
              ))}
            </select>
          </label>
          <label class={styles.item}>
            <span class="label-text whitespace-nowrap">{t('Language')}</span>
            <select
              class="select select-xs"
              onChange={(e) => {
                const language = (e.target as HTMLSelectElement)?.value ?? detectBrowserLanguage();
                i18n.changeLanguage(language);
                options.set('language', language);
              }}
            >
              {Object.entries(LANGUAGES_CONFIG).map(([langTag, langConf]) => (
                <option
                  key={langTag}
                  value={langTag}
                  selected={options.get('language') === langTag}
                >
                  {langConf.nameEn} - {langConf.name}
                </option>
              ))}
            </select>
          </label>
          <label class={styles.item}>
            <span class="label-text whitespace-nowrap">{t('Debug')}</span>
            <input
              type="checkbox"
              class="toggle toggle-primary"
              checked={options.get('debug')}
              onChange={(e) => {
                options.set('debug', (e.target as HTMLInputElement)?.checked);
              }}
            />
          </label>
          <label class={styles.item}>
            <div class="flex items-center">
              <span class="label-text whitespace-nowrap">{t('Date Time Format')}</span>
              <a
                href="https://day.js.org/docs/en/display/format"
                target="_blank"
                rel="noopener noreferrer"
                class="tooltip tooltip-bottom ml-0.5 before:max-w-40"
                data-tip={t(
                  'Click for more information. This will take effect on both previewer and exported files.',
                )}
              >
                <IconHelp size={20} />
              </a>
            </div>
            <input
              type="text"
              class="input input-bordered input-xs w-48"
              value={options.get('dateTimeFormat')}
              onChange={(e) => {
                options.set('dateTimeFormat', (e.target as HTMLInputElement)?.value);
              }}
            />
          </label>
          {/* Database operations. */}
          <label class={styles.item}>
            <div class="flex items-center">
              <span class="label-text whitespace-nowrap">{t('Use dedicated DB for accounts')}</span>
              <a
                class="tooltip tooltip-bottom ml-0.5 before:max-w-40"
                data-tip={t(
                  'This will create separate database for each Twitter account, which can help reduce the chance of data mixing when you use multiple accounts.',
                )}
              >
                <IconHelp size={20} />
              </a>
            </div>
            <input
              type="checkbox"
              class="toggle toggle-primary"
              checked={options.get('dedicatedDbForAccounts')}
              onChange={(e) => {
                options.set('dedicatedDbForAccounts', (e.target as HTMLInputElement)?.checked);
              }}
            />
          </label>
          <div class={styles.item}>
            <div class="flex items-center">
              <span class="label-text whitespace-nowrap">{t('Local Database')}</span>
            </div>
            <div class="flex flex-wrap justify-end gap-2">
              <button
                class="btn btn-xs btn-neutral"
                onClick={async () => {
                  let storageUsageText = 'Storage usage: N/A';
                  if (typeof navigator.storage.estimate === 'function') {
                    const { quota = 1, usage = 0 } = await navigator.storage.estimate();
                    const usageMB = (usage / 1024 / 1024).toFixed(2);
                    const quotaMB = (quota / 1024 / 1024).toFixed(2);
                    storageUsageText = `Storage usage: ${usageMB}MB / ${quotaMB}MB`;
                  }

                  const count = await db.count();
                  alert(
                    storageUsageText +
                      '\n\nIndexedDB tables count:\n' +
                      JSON.stringify(count, undefined, '  '),
                  );
                }}
              >
                <IconReportAnalytics size={20} />
                {t('Analyze DB')}
              </button>
              <button
                class="btn btn-xs btn-primary"
                onClick={async () => {
                  const blob = await db.export();
                  if (blob) {
                    saveFile(`twitter-web-exporter-${Date.now()}.json`, blob);
                  }
                }}
              >
                <IconDatabaseExport size={20} />
                {t('Export DB')}
              </button>
              <button class="btn btn-xs btn-secondary" onClick={onExportMigration}>
                <IconDatabaseExport size={20} />
                {t('Export Migration')}
              </button>
              <button
                class="btn btn-xs btn-secondary"
                onClick={() => {
                  importInputRef.current?.click();
                }}
              >
                <IconDatabaseImport size={20} />
                {t('Import Migration')}
              </button>
              <button
                class="btn btn-xs btn-warning"
                onClick={async () => {
                  if (confirm(t('Are you sure to clear all data in the database?'))) {
                    await db.clear();
                  }
                }}
              >
                <IconTrashX size={20} />
                {t('Clear DB')}
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                class="hidden"
                onChange={onImportMigration}
              />
            </div>
          </div>
        </div>
        <p class={styles.subtitle}>Cloud Sync</p>
        <div class={cx(styles.block, 'flex-col')}>
          <label class={styles.item}>
            <span class="label-text whitespace-nowrap">Enable Sync</span>
            <input
              type="checkbox"
              class="toggle toggle-primary"
              checked={syncEnabled.value}
              onChange={(e) => {
                syncEnabled.value = (e.target as HTMLInputElement)?.checked;
                options.set('syncEnabled', syncEnabled.value);
              }}
            />
          </label>
          <label class={styles.item}>
            <span class="label-text whitespace-nowrap">Sync Backend</span>
            <select
              class="select select-xs"
              value={syncBackend.value}
              onChange={(e) => {
                const nextBackend =
                  (e.target as HTMLSelectElement)?.value === 'minio' ? 'minio' : 'supabase';
                syncBackend.value = nextBackend;
                options.set('syncBackend', nextBackend);
              }}
            >
              <option value="supabase">Supabase</option>
              <option value="minio">MinIO</option>
            </select>
          </label>
          {syncBackend.value === 'supabase' ? (
            <Fragment>
              <label class={styles.item}>
                <span class="label-text whitespace-nowrap">{t('Supabase URL')}</span>
                <input
                  type="text"
                  class="input input-bordered input-xs w-48"
                  value={supabaseUrl.value}
                  onChange={(e) => {
                    supabaseUrl.value = (e.target as HTMLInputElement)?.value ?? '';
                    options.set('supabaseUrl', supabaseUrl.value.trim());
                  }}
                />
              </label>
              <label class={styles.item}>
                <span class="label-text whitespace-nowrap">{t('Supabase Anon Key')}</span>
                <input
                  type="password"
                  class="input input-bordered input-xs w-48"
                  value={supabaseAnonKey.value}
                  onChange={(e) => {
                    supabaseAnonKey.value = (e.target as HTMLInputElement)?.value ?? '';
                    options.set('supabaseAnonKey', supabaseAnonKey.value.trim());
                  }}
                />
              </label>
              <label class={styles.item}>
                <span class="label-text whitespace-nowrap">{t('Lzc API Auth Token')}</span>
                <input
                  type="password"
                  class="input input-bordered input-xs w-48"
                  value={lzcApiAuthToken.value}
                  onChange={(e) => {
                    lzcApiAuthToken.value = (e.target as HTMLInputElement)?.value ?? '';
                    options.set('lzcApiAuthToken', lzcApiAuthToken.value.trim());
                  }}
                />
              </label>
            </Fragment>
          ) : (
            <Fragment>
              <label class={styles.item}>
                <span class="label-text whitespace-nowrap">MinIO Endpoint</span>
                <input
                  type="text"
                  class="input input-bordered input-xs w-48"
                  value={minioEndpoint.value}
                  onChange={(e) => {
                    minioEndpoint.value = (e.target as HTMLInputElement)?.value ?? '';
                    options.set('minioEndpoint', minioEndpoint.value.trim());
                  }}
                />
              </label>
              <label class={styles.item}>
                <span class="label-text whitespace-nowrap">MinIO Bucket</span>
                <input
                  type="text"
                  class="input input-bordered input-xs w-48"
                  value={minioBucket.value}
                  onChange={(e) => {
                    minioBucket.value = (e.target as HTMLInputElement)?.value ?? '';
                    options.set('minioBucket', minioBucket.value.trim());
                  }}
                />
              </label>
              <label class={styles.item}>
                <span class="label-text whitespace-nowrap">MinIO Region</span>
                <input
                  type="text"
                  class="input input-bordered input-xs w-48"
                  value={minioRegion.value}
                  onChange={(e) => {
                    minioRegion.value = (e.target as HTMLInputElement)?.value ?? 'us-east-1';
                    options.set('minioRegion', minioRegion.value.trim() || 'us-east-1');
                  }}
                />
              </label>
              <label class={styles.item}>
                <span class="label-text whitespace-nowrap">MinIO Access Key ID</span>
                <input
                  type="password"
                  class="input input-bordered input-xs w-48"
                  value={minioAccessKeyId.value}
                  onChange={(e) => {
                    minioAccessKeyId.value = (e.target as HTMLInputElement)?.value ?? '';
                    options.set('minioAccessKeyId', minioAccessKeyId.value.trim());
                  }}
                />
              </label>
              <label class={styles.item}>
                <span class="label-text whitespace-nowrap">MinIO Secret Access Key</span>
                <input
                  type="password"
                  class="input input-bordered input-xs w-48"
                  value={minioSecretAccessKey.value}
                  onChange={(e) => {
                    minioSecretAccessKey.value = (e.target as HTMLInputElement)?.value ?? '';
                    options.set('minioSecretAccessKey', minioSecretAccessKey.value.trim());
                  }}
                />
              </label>
            </Fragment>
          )}
          <div class={styles.item}>
            <span class="label-text whitespace-nowrap">{t('Manual Sync')}</span>
            <button
              class="btn btn-xs btn-secondary"
              onClick={async () => {
                await syncManager.runNow();
              }}
            >
              <IconRefresh size={20} />
              {t('Sync Now')}
            </button>
          </div>
        </div>
        <p class={styles.subtitle}>{t('Manual Batch Capture')}</p>
        <div class={cx(styles.block, 'flex-col')}>
          <div class={styles.item}>
            <span class="label-text whitespace-nowrap">{t('Run helper capture flow')}</span>
            <button class="btn btn-xs btn-accent" onClick={toggleBatchCapture}>
              <IconRefresh size={20} />
              {t('Open')}
            </button>
          </div>
        </div>
        {/* Enable or disable modules. */}
        <p class={styles.subtitle}>{t('Modules (Scroll to see more)')}</p>
        <div class={cx(styles.block, 'flex-col', 'max-h-44 overflow-scroll')}>
          {extensionManager.getExtensions().map((extension) => (
            <label class={cx(styles.item, 'flex-shrink-0')} key={extension.name}>
              <span>
                {t(extension.name.replace('Module', '') as TranslationKey)} {t('Module')}
              </span>
              <input
                type="checkbox"
                class="toggle toggle-secondary"
                checked={extension.enabled}
                onChange={() => {
                  if (extension.enabled) {
                    extensionManager.disable(extension.name);
                  } else {
                    extensionManager.enable(extension.name);
                  }
                }}
              />
            </label>
          ))}
        </div>
        {/* Information about this script. */}
        <p class={styles.subtitle}>{t('About')}</p>
        <div class={styles.block}>
          <span class="label-text whitespace-nowrap">
            {t('Version')} {packageJson.version}
          </span>
          <a class="btn btn-xs btn-ghost" target="_blank" href={packageJson.homepage}>
            <IconBrandGithubFilled class="[&>path]:stroke-0" />
            GitHub
          </a>
        </div>
      </Modal>
      <BatchCaptureModal show={showBatchCapture} onClose={toggleBatchCapture} />
    </Fragment>
  );
}
