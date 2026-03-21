import { AppOptions } from '@/core/options';

export const MIGRATION_PACKAGE_VERSION = 1;

export interface MigrationPackageV1 {
  version: typeof MIGRATION_PACKAGE_VERSION;
  exportedAt: string;
  appVersion: string;
  database: unknown;
  options: AppOptions;
}
