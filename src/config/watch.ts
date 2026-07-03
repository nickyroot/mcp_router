// Config hot reload (v0.3). Watches the directory rather than the file so
// atomic-rename saves (how most editors write) keep being observed, and
// debounces because a single save can emit several fs events.

import { watch } from "node:fs";
import { basename, dirname } from "node:path";

export function watchConfig(
  path: string,
  onChange: () => void,
  debounceMs = 300,
): () => void {
  const target = basename(path);
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dirname(path), (_event, filename) => {
    if (filename !== null && filename !== target) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
    timer.unref?.();
  });
  watcher.unref?.();
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
