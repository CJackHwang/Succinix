export interface TerminalDimensions {
  cols: number;
  rows: number;
  revision: number;
}

const dimensionsByInstance = new Map<string, TerminalDimensions>();
const listenersByInstance = new Map<string, Set<(dimensions: TerminalDimensions) => void>>();

/** 保存执行世界终端的当前尺寸，并通知正在等待尺寸变化的 raw 应用。 */
export function setTerminalDimensions(instanceId: string, cols: number, rows: number): void {
  const previous = dimensionsByInstance.get(instanceId);
  const next = {
    cols: normalizeDimension(cols, 80),
    rows: normalizeDimension(rows, 24),
    revision: previous?.revision ?? 0,
  };
  if (previous?.cols === next.cols && previous.rows === next.rows) return;
  next.revision++;
  dimensionsByInstance.set(instanceId, next);
  for (const listener of listenersByInstance.get(instanceId) ?? []) listener({ ...next });
}

export function getTerminalDimensions(instanceId: string | undefined): TerminalDimensions | undefined {
  if (!instanceId) return undefined;
  const dimensions = dimensionsByInstance.get(instanceId);
  return dimensions && { ...dimensions };
}

export function clearTerminalDimensions(instanceId: string): void {
  dimensionsByInstance.delete(instanceId);
  listenersByInstance.delete(instanceId);
}

/** 等待比 `revision` 更新的尺寸；取消函数会释放未命中的等待者。 */
export function watchTerminalDimensions(instanceId: string | undefined, revision: number): {
  promise: Promise<TerminalDimensions>;
  cancel: () => void;
} {
  const current = getTerminalDimensions(instanceId);
  if (current && current.revision > revision) return { promise: Promise.resolve(current), cancel: () => {} };
  let cancel = () => {};
  const promise = new Promise<TerminalDimensions>((resolve) => {
    if (!instanceId) return;
    const listener = (dimensions: TerminalDimensions) => {
      if (dimensions.revision <= revision) return;
      cancel();
      resolve(dimensions);
    };
    const listeners = listenersByInstance.get(instanceId) ?? new Set();
    listeners.add(listener);
    listenersByInstance.set(instanceId, listeners);
    cancel = () => {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByInstance.delete(instanceId);
    };
  });
  return { promise, cancel };
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
