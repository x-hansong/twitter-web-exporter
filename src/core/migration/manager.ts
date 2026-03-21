import packageJson from '@/../package.json';
import { db } from '@/core/database';
import { options } from '@/core/options';
import { safeJSONParse } from '@/utils/common';
import logger from '@/utils/logger';
import { MIGRATION_PACKAGE_VERSION, MigrationPackageV1 } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildDatabaseBlob(database: unknown) {
  return new Blob([JSON.stringify(database)], {
    type: 'application/json;charset=utf-8',
  });
}

export class MigrationManager {
  async exportPackage() {
    const databaseBlob = await db.export();
    if (!databaseBlob) {
      throw new Error('Failed to export database.');
    }

    const databaseText = await databaseBlob.text();
    const database = safeJSONParse(databaseText);
    if (!database) {
      throw new Error('Failed to serialize database export.');
    }

    const migrationPackage: MigrationPackageV1 = {
      version: MIGRATION_PACKAGE_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: packageJson.version,
      database,
      options: options.exportSnapshot(),
    };

    logger.info('Migration package exported', {
      version: migrationPackage.version,
      appVersion: migrationPackage.appVersion,
      exportedAt: migrationPackage.exportedAt,
    });

    return new Blob([JSON.stringify(migrationPackage, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
  }

  async parsePackage(file: Blob) {
    const text = await file.text();
    const parsed = safeJSONParse(text);

    if (!isRecord(parsed)) {
      throw new Error('Invalid migration package file.');
    }

    if (parsed.version !== MIGRATION_PACKAGE_VERSION) {
      throw new Error(
        `Unsupported migration package version: ${String(parsed.version ?? 'unknown')}.`,
      );
    }

    if (
      typeof parsed.exportedAt !== 'string' ||
      typeof parsed.appVersion !== 'string' ||
      !('database' in parsed) ||
      !isRecord(parsed.options)
    ) {
      throw new Error('Migration package is missing required fields.');
    }

    return parsed as unknown as MigrationPackageV1;
  }

  async importPackage(file: Blob) {
    const migrationPackage = await this.parsePackage(file);
    await db.replaceFromBlob(buildDatabaseBlob(migrationPackage.database));
    options.replaceAll(migrationPackage.options, false);
    logger.info('Migration package imported', {
      version: migrationPackage.version,
      appVersion: migrationPackage.appVersion,
      exportedAt: migrationPackage.exportedAt,
    });
    return migrationPackage;
  }
}
