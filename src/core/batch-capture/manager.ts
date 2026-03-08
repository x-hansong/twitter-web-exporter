import { Signal } from '@preact/signals';
import { db } from '@/core/database';
import extensions from '@/core/extensions';
import { options } from '@/core/options';
import logger from '@/utils/logger';
import {
  BATCH_CAPTURE_TASKS,
  BatchCaptureConfig,
  BatchCaptureState,
  BatchCaptureTaskKey,
  DEFAULT_MAX_SCROLL_STEPS,
  DEFAULT_SCROLL_DISTANCE_MULTIPLIER,
  DEFAULT_BATCH_CAPTURE_STATE,
  COOLDOWN_EVERY_SCROLLS,
  LONG_COOLDOWN_WAIT_MS,
  MAX_STABLE_ROUNDS,
  MAX_TASK_RUNTIME_MS,
  NAVIGATION_TIMEOUT_MS,
  PAGE_READY_TIMEOUT_MS,
  PAGE_WARMUP_WAIT_MS,
  SHORT_SCROLL_WAIT_MS,
} from './types';

type TaskDefinition = {
  key: BatchCaptureTaskKey;
  extensionName: string;
  getTargetPath: () => string | null;
  navigate: () => boolean;
  isActivePath: (targetPath: string | null) => boolean;
  isPageReady: () => boolean;
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function getScrollHeight() {
  return Math.max(
    document.body?.scrollHeight ?? 0,
    document.documentElement?.scrollHeight ?? 0,
    document.body?.offsetHeight ?? 0,
    document.documentElement?.offsetHeight ?? 0,
  );
}

function normalizePath(pathname: string) {
  return pathname.replace(/\/+$/, '') || '/';
}

function getCurrentPath() {
  return normalizePath(window.location.pathname);
}

function sanitizeMaxOperations(value?: number) {
  return Math.max(1, Math.floor(value ?? DEFAULT_MAX_SCROLL_STEPS));
}

function sanitizeScrollDistanceMultiplier(value?: number) {
  return Math.max(1, Number(value ?? DEFAULT_SCROLL_DISTANCE_MULTIPLIER));
}

function getProfileLink() {
  return document.querySelector(
    'a[data-testid="AppTabBar_Profile_Link"]',
  ) as HTMLAnchorElement | null;
}

function getBookmarksLink() {
  return (
    (document.querySelector('a[href="/i/bookmarks"]') as HTMLAnchorElement | null) ??
    (document.querySelector('a[href$="/bookmarks"]') as HTMLAnchorElement | null)
  );
}

export class BatchCaptureManager {
  private state: BatchCaptureState = { ...DEFAULT_BATCH_CAPTURE_STATE };
  private runId = 0;

  public signal = new Signal(0);

  public getState() {
    return this.state;
  }

  public isRunning() {
    return this.state.running;
  }

  public start(config: BatchCaptureConfig) {
    if (this.state.running) {
      return false;
    }

    if (config.tasks.length === 0) {
      this.updateState({
        error: 'Please select at least one task.',
        message: '',
      });
      return false;
    }

    const disabledTask = config.tasks.find((task) => !this.isTaskEnabled(task));
    if (disabledTask) {
      const taskLabel = this.getTaskLabel(disabledTask);
      this.updateState({
        status: 'failed',
        error: `${taskLabel} module is disabled. Please enable it in settings first.`,
        message: '',
        running: false,
        currentTask: null,
        currentTaskLabel: '',
        endedAt: Date.now(),
      });
      return false;
    }

    this.runId += 1;
    const currentRunId = this.runId;

    this.state = {
      ...DEFAULT_BATCH_CAPTURE_STATE,
      running: true,
      status: 'navigating',
      selectedTasks: [...config.tasks],
      message: 'Preparing batch capture...',
      startedAt: Date.now(),
    };
    this.signal.value++;

    void this.run(config, currentRunId);
    return true;
  }

  public stop() {
    if (!this.state.running) {
      return;
    }

    this.runId += 1;
    this.updateState({
      running: false,
      status: 'stopped',
      message: 'Stopping current task...',
      endedAt: Date.now(),
    });
  }

  private async run(config: BatchCaptureConfig, runId: number) {
    logger.info('Batch capture started', config);

    try {
      let totalCapturedDelta = 0;
      const completedTasks: BatchCaptureTaskKey[] = [];

      for (const task of config.tasks) {
        this.assertRun(runId);
        const result = await this.runTask(task, runId);
        totalCapturedDelta += result.capturedDelta;
        completedTasks.push(task);

        this.updateState({
          totalCapturedDelta,
          completedTasks: [...completedTasks],
        });
      }

      this.assertRun(runId);
      this.updateState({
        running: false,
        status: 'completed',
        currentTask: null,
        currentTaskLabel: '',
        message: 'Batch capture completed.',
        error: '',
        endedAt: Date.now(),
      });
      logger.info('Batch capture completed', { totalCapturedDelta });
    } catch (error) {
      if (!this.isCurrentRun(runId)) {
        logger.info('Batch capture interrupted by stop request');
        return;
      }

      const message = (error as Error).message;
      this.updateState({
        running: false,
        status: 'failed',
        error: message,
        message: '',
        endedAt: Date.now(),
      });
      logger.error('Batch capture failed', error);
    }
  }

  private async runTask(taskKey: BatchCaptureTaskKey, runId: number) {
    const task = this.getTaskDefinition(taskKey);
    const taskLabel = this.getTaskLabel(taskKey);

    this.updateState({
      status: 'navigating',
      currentTask: taskKey,
      currentTaskLabel: taskLabel,
      message: `Opening ${taskLabel} page...`,
      error: '',
      scrollCount: 0,
      stableRounds: 0,
      currentTaskCapturedDelta: 0,
      lastIncrease: 0,
    });

    await this.ensureTaskContext(task, runId);

    this.updateState({
      status: 'warming',
      message: `Waiting for ${taskLabel} page to settle...`,
    });
    await this.waitForReady(task, runId);
    await this.waitForStopAware(PAGE_WARMUP_WAIT_MS, runId);

    const initialCount = (await db.extGetCaptureCount(task.extensionName)) ?? 0;
    let lastCount = initialCount;
    let lastHeight = getScrollHeight();
    let stableRounds = 0;
    const taskStartedAt = Date.now();
    const maxScrollSteps = sanitizeMaxOperations(options.get('batchCaptureMaxOperations'));
    const scrollDistanceMultiplier = sanitizeScrollDistanceMultiplier(
      options.get('batchCaptureScrollDistanceMultiplier'),
    );
    const scrollDistance =
      Math.max(Math.floor(window.innerHeight * 0.9), 640) * scrollDistanceMultiplier;

    for (let step = 1; step <= maxScrollSteps; step++) {
      this.assertRun(runId);

      if (Date.now() - taskStartedAt >= MAX_TASK_RUNTIME_MS) {
        break;
      }

      this.updateState({
        status: 'scrolling',
        message: `Capturing ${taskLabel}...`,
        scrollCount: step,
      });

      window.scrollBy({
        top: scrollDistance,
        left: 0,
        behavior: 'smooth',
      });

      await this.waitForStopAware(SHORT_SCROLL_WAIT_MS, runId);

      const currentCount = (await db.extGetCaptureCount(task.extensionName)) ?? lastCount;
      const currentHeight = getScrollHeight();
      const countIncrease = Math.max(currentCount - lastCount, 0);
      const taskCapturedDelta = Math.max(currentCount - initialCount, 0);
      const heightChanged = Math.abs(currentHeight - lastHeight) > 8;

      stableRounds = countIncrease === 0 && !heightChanged ? stableRounds + 1 : 0;

      this.updateState({
        currentTaskCapturedDelta: taskCapturedDelta,
        lastIncrease: countIncrease,
        stableRounds,
      });

      lastCount = currentCount;
      lastHeight = currentHeight;

      if (stableRounds >= MAX_STABLE_ROUNDS) {
        break;
      }

      if (step % COOLDOWN_EVERY_SCROLLS === 0) {
        this.updateState({
          status: 'cooldown',
          message: `Cooling down after ${taskLabel} scroll burst...`,
        });
        await this.waitForStopAware(LONG_COOLDOWN_WAIT_MS, runId);
      }
    }

    const capturedDelta = Math.max(lastCount - initialCount, 0);
    this.updateState({
      message: `${taskLabel} capture finished.`,
      currentTaskCapturedDelta: capturedDelta,
    });

    return { capturedDelta };
  }

  private async ensureTaskContext(task: TaskDefinition, runId: number) {
    const targetPath = task.getTargetPath();
    if (task.isActivePath(targetPath)) {
      return;
    }

    const navigated = task.navigate();
    if (!navigated) {
      throw new Error(
        `Unable to open ${this.getTaskLabel(task.key)} page from the current layout.`,
      );
    }

    await this.waitFor(
      () => task.isActivePath(targetPath),
      NAVIGATION_TIMEOUT_MS,
      `Timed out while opening ${this.getTaskLabel(task.key)} page.`,
      runId,
    );
  }

  private async waitForReady(task: TaskDefinition, runId: number) {
    await this.waitFor(
      () => task.isPageReady(),
      PAGE_READY_TIMEOUT_MS,
      `${this.getTaskLabel(task.key)} page did not become ready in time.`,
      runId,
    );
  }

  private async waitFor(
    predicate: () => boolean,
    timeoutMs: number,
    timeoutMessage: string,
    runId: number,
  ) {
    const startAt = Date.now();

    while (Date.now() - startAt < timeoutMs) {
      this.assertRun(runId);
      if (predicate()) {
        return;
      }
      await wait(250);
    }

    throw new Error(timeoutMessage);
  }

  private async waitForStopAware(ms: number, runId: number) {
    const deadline = Date.now() + ms;

    while (Date.now() < deadline) {
      this.assertRun(runId);
      await wait(Math.min(250, Math.max(deadline - Date.now(), 0)));
    }
  }

  private getTaskDefinition(taskKey: BatchCaptureTaskKey): TaskDefinition {
    if (taskKey === BATCH_CAPTURE_TASKS.BOOKMARKS) {
      return {
        key: taskKey,
        extensionName: 'BookmarksModule',
        getTargetPath: () => '/i/bookmarks',
        navigate: () => {
          const link = getBookmarksLink();
          if (!link) {
            return false;
          }
          link.click();
          return true;
        },
        isActivePath: (targetPath) => getCurrentPath() === normalizePath(targetPath ?? ''),
        isPageReady: () => !!document.querySelector('[data-testid="primaryColumn"]'),
      };
    }

    return {
      key: taskKey,
      extensionName: 'UserTweetsModule',
      getTargetPath: () => {
        const link = getProfileLink();
        if (!link) {
          return null;
        }

        const href = new URL(link.href, window.location.origin);
        return normalizePath(href.pathname);
      },
      navigate: () => {
        const link = getProfileLink();
        if (!link) {
          return false;
        }
        link.click();
        return true;
      },
      isActivePath: (targetPath) => {
        if (!targetPath) {
          return false;
        }
        return getCurrentPath() === normalizePath(targetPath);
      },
      isPageReady: () => !!document.querySelector('[data-testid="primaryColumn"]'),
    };
  }

  private isTaskEnabled(taskKey: BatchCaptureTaskKey) {
    const extensionName =
      taskKey === BATCH_CAPTURE_TASKS.BOOKMARKS ? 'BookmarksModule' : 'UserTweetsModule';
    return extensions
      .getExtensions()
      .some((extension) => extension.name === extensionName && extension.enabled);
  }

  private getTaskLabel(taskKey: BatchCaptureTaskKey) {
    if (taskKey === BATCH_CAPTURE_TASKS.BOOKMARKS) {
      return 'Bookmarks';
    }

    return 'My Tweets';
  }

  private updateState(partial: Partial<BatchCaptureState>) {
    this.state = {
      ...this.state,
      ...partial,
    };
    this.signal.value++;
  }

  private assertRun(runId: number) {
    if (!this.isCurrentRun(runId)) {
      throw new Error('Batch capture stopped');
    }
  }

  private isCurrentRun(runId: number) {
    return this.runId === runId;
  }
}
