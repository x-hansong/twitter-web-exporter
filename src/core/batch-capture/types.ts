export const BATCH_CAPTURE_TASKS = {
  BOOKMARKS: 'bookmarks',
  USER_TWEETS: 'userTweets',
} as const;

export type BatchCaptureTaskKey = (typeof BATCH_CAPTURE_TASKS)[keyof typeof BATCH_CAPTURE_TASKS];

export type BatchCaptureStatus =
  | 'idle'
  | 'navigating'
  | 'warming'
  | 'scrolling'
  | 'cooldown'
  | 'completed'
  | 'stopped'
  | 'failed';

export type BatchCaptureConfig = {
  tasks: BatchCaptureTaskKey[];
};

export type BatchCaptureState = {
  running: boolean;
  status: BatchCaptureStatus;
  selectedTasks: BatchCaptureTaskKey[];
  completedTasks: BatchCaptureTaskKey[];
  currentTask: BatchCaptureTaskKey | null;
  currentTaskLabel: string;
  message: string;
  error: string;
  scrollCount: number;
  stableRounds: number;
  currentTaskCapturedDelta: number;
  totalCapturedDelta: number;
  lastIncrease: number;
  startedAt: number | null;
  endedAt: number | null;
};

export const SHORT_SCROLL_WAIT_MS = 1400;
export const COOLDOWN_EVERY_SCROLLS = 8;
export const LONG_COOLDOWN_WAIT_MS = 5000;
export const MAX_STABLE_ROUNDS = 4;
export const DEFAULT_MAX_SCROLL_STEPS = 5000;
export const DEFAULT_SCROLL_DISTANCE_MULTIPLIER = 3;
export const MAX_TASK_RUNTIME_MS = 12 * 60 * 1000;
export const NAVIGATION_TIMEOUT_MS = 12000;
export const PAGE_READY_TIMEOUT_MS = 8000;
export const PAGE_WARMUP_WAIT_MS = 1500;

export const DEFAULT_BATCH_CAPTURE_STATE: BatchCaptureState = {
  running: false,
  status: 'idle',
  selectedTasks: [],
  completedTasks: [],
  currentTask: null,
  currentTaskLabel: '',
  message: '',
  error: '',
  scrollCount: 0,
  stableRounds: 0,
  currentTaskCapturedDelta: 0,
  totalCapturedDelta: 0,
  lastIncrease: 0,
  startedAt: null,
  endedAt: null,
};
