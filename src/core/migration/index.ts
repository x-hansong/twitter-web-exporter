import { MigrationManager } from './manager';

export * from './manager';
export * from './types';

const migrationManager = new MigrationManager();

export { migrationManager };
