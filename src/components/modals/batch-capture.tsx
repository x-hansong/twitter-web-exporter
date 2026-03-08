import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Modal } from '@/components/common';
import { options } from '@/core/options';
import { TranslationKey, useTranslation } from '@/i18n';
import {
  batchCaptureManager,
  BATCH_CAPTURE_TASKS,
  BatchCaptureTaskKey,
  DEFAULT_MAX_SCROLL_STEPS,
  DEFAULT_SCROLL_DISTANCE_MULTIPLIER,
} from '@/core/batch-capture';

type BatchCaptureModalProps = {
  show?: boolean;
  onClose?: () => void;
};

const TASK_OPTIONS: Array<{ value: BatchCaptureTaskKey; labelKey: string }> = [
  { value: BATCH_CAPTURE_TASKS.BOOKMARKS, labelKey: 'Bookmarks' },
  { value: BATCH_CAPTURE_TASKS.USER_TWEETS, labelKey: 'My Tweets' },
];

export function BatchCaptureModal({ show, onClose }: BatchCaptureModalProps) {
  const { t } = useTranslation();
  const selectedTasks = useSignal<BatchCaptureTaskKey[]>([
    BATCH_CAPTURE_TASKS.BOOKMARKS,
    BATCH_CAPTURE_TASKS.USER_TWEETS,
  ]);
  const state = useSignal(batchCaptureManager.getState());
  const maxOperations = useSignal(
    options.get('batchCaptureMaxOperations', DEFAULT_MAX_SCROLL_STEPS),
  );
  const scrollDistanceMultiplier = useSignal(
    options.get('batchCaptureScrollDistanceMultiplier', DEFAULT_SCROLL_DISTANCE_MULTIPLIER),
  );

  useEffect(() => {
    const unsubscribe = batchCaptureManager.signal.subscribe(() => {
      state.value = batchCaptureManager.getState();
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = options.signal.subscribe(() => {
      maxOperations.value = options.get('batchCaptureMaxOperations', DEFAULT_MAX_SCROLL_STEPS);
      scrollDistanceMultiplier.value = options.get(
        'batchCaptureScrollDistanceMultiplier',
        DEFAULT_SCROLL_DISTANCE_MULTIPLIER,
      );
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const toggleTask = (task: BatchCaptureTaskKey) => {
    if (state.value.running) {
      return;
    }

    if (selectedTasks.value.includes(task)) {
      selectedTasks.value = selectedTasks.value.filter((item) => item !== task);
    } else {
      selectedTasks.value = [...selectedTasks.value, task];
    }
  };

  return (
    <Modal
      title={t('Manual Batch Capture')}
      show={show}
      onClose={onClose}
      class="max-w-lg md:max-w-screen-sm"
    >
      <div class="px-4 text-base">
        <p class="text-sm leading-5 text-base-content text-opacity-70 mb-3">
          {t(
            'This helper opens the target page and scrolls for you. It only captures what the Twitter/X web app has loaded, and it does not send its own API requests.',
          )}
        </p>
        <p class="text-sm leading-5 text-base-content text-opacity-70 mb-4">
          {t(
            'Use conservative pacing to reduce rate-limit risk. My Tweets only covers what is still visible from the web app timeline.',
          )}
        </p>

        <div class="mb-4">
          <p class="font-medium text-sm mb-2">{t('Capture tasks')}</p>
          <div class="space-y-2">
            {TASK_OPTIONS.map((option) => (
              <label key={option.value} class="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  class="checkbox checkbox-sm checkbox-primary"
                  checked={selectedTasks.value.includes(option.value)}
                  disabled={state.value.running}
                  onChange={() => toggleTask(option.value)}
                />
                <span class="ml-2 text-sm">{t(option.labelKey as TranslationKey)}</span>
              </label>
            ))}
          </div>
        </div>

        <div class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm mb-4">
          <label class="flex flex-col">
            <span class="mb-1 text-base-content text-opacity-70">{t('Max operations')}</span>
            <input
              type="number"
              min="1"
              step="1"
              class="input input-bordered input-sm"
              value={String(maxOperations.value)}
              disabled={state.value.running}
              onInput={(e) => {
                const nextValue = Math.max(
                  1,
                  Math.floor(
                    Number((e.target as HTMLInputElement).value) || DEFAULT_MAX_SCROLL_STEPS,
                  ),
                );
                maxOperations.value = nextValue;
                options.set('batchCaptureMaxOperations', nextValue);
              }}
            />
          </label>
          <label class="flex flex-col">
            <span class="mb-1 text-base-content text-opacity-70">
              {t('Scroll distance multiplier')}
            </span>
            <input
              type="number"
              min="1"
              step="1"
              class="input input-bordered input-sm"
              value={String(scrollDistanceMultiplier.value)}
              disabled={state.value.running}
              onInput={(e) => {
                const nextValue = Math.max(
                  1,
                  Math.floor(
                    Number((e.target as HTMLInputElement).value) ||
                      DEFAULT_SCROLL_DISTANCE_MULTIPLIER,
                  ),
                );
                scrollDistanceMultiplier.value = nextValue;
                options.set('batchCaptureScrollDistanceMultiplier', nextValue);
              }}
            />
          </label>
        </div>

        <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-4">
          <span class="text-base-content text-opacity-70">{t('Short wait')}</span>
          <span class="font-mono">1400ms</span>
          <span class="text-base-content text-opacity-70">{t('Cooldown')}</span>
          <span class="font-mono">8 / 5000ms</span>
          <span class="text-base-content text-opacity-70">{t('Stop rule')}</span>
          <span>{t('4 stable rounds or configurable max operations')}</span>
        </div>

        <div class="rounded-box bg-base-200 px-3 py-3 text-sm">
          <div class="flex justify-between">
            <span class="text-base-content text-opacity-70">{t('Status')}</span>
            <span class="font-medium">{t(thisStateLabel(state.value.status))}</span>
          </div>
          <div class="flex justify-between mt-1">
            <span class="text-base-content text-opacity-70">{t('Current task')}</span>
            <span>
              {state.value.currentTaskLabel
                ? t(state.value.currentTaskLabel as TranslationKey)
                : '-'}
            </span>
          </div>
          <div class="flex justify-between mt-1">
            <span class="text-base-content text-opacity-70">{t('Scrolls')}</span>
            <span class="font-mono">{state.value.scrollCount}</span>
          </div>
          <div class="flex justify-between mt-1">
            <span class="text-base-content text-opacity-70">{t('Stable rounds')}</span>
            <span class="font-mono">{state.value.stableRounds}</span>
          </div>
          <div class="flex justify-between mt-1">
            <span class="text-base-content text-opacity-70">{t('New captures')}</span>
            <span class="font-mono">
              +{state.value.currentTaskCapturedDelta} / +{state.value.totalCapturedDelta}
            </span>
          </div>
          <div class="flex justify-between mt-1">
            <span class="text-base-content text-opacity-70">{t('Last increase')}</span>
            <span class="font-mono">+{state.value.lastIncrease}</span>
          </div>
          {state.value.message ? (
            <p class="mt-3 text-base-content text-opacity-80">{state.value.message}</p>
          ) : null}
          {state.value.error ? <p class="mt-2 text-error leading-5">{state.value.error}</p> : null}
        </div>
      </div>

      <div class="flex space-x-2 mt-4">
        <span class="flex-grow" />
        <button class="btn" onClick={onClose}>
          {t('Close')}
        </button>
        <button
          class="btn btn-warning"
          disabled={!state.value.running}
          onClick={() => batchCaptureManager.stop()}
        >
          {t('Stop')}
        </button>
        <button
          class="btn btn-primary"
          disabled={state.value.running}
          onClick={() => {
            batchCaptureManager.start({ tasks: selectedTasks.value });
          }}
        >
          {t('Start Capture')}
        </button>
      </div>
    </Modal>
  );
}

function thisStateLabel(status: string): TranslationKey {
  switch (status) {
    case 'navigating':
      return 'Navigating';
    case 'warming':
      return 'Warming up';
    case 'scrolling':
      return 'Scrolling';
    case 'cooldown':
      return 'Cooling down';
    case 'completed':
      return 'Completed';
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return 'Failed';
    default:
      return 'Idle';
  }
}
