import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { runDemo, replayBundle, selectPython } from "./aas.mjs";

const GUI_TASK_KIND = "agent-action-stack.gui-task/v1";

/** Keep synchronous component processes off the HTTP event loop.
 * Each task owns one worker through its exit, so a server lease never ends
 * while component work is still running. Existing child bounds stay intact.
 */
export function runGuiTask(task) {
  return new Promise((resolve, reject) => {
    let result;
    let failure;
    const worker = new Worker(new URL(import.meta.url), { workerData: { kind: GUI_TASK_KIND, task } });
    worker.on("message", (message) => { result = message; });
    worker.on("error", (error) => { failure = error; });
    worker.on("exit", (code) => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`GUI worker exited with code ${code}.`));
      else if (result?.ok === true) resolve(result.value);
      else reject(new Error(result?.error ?? "GUI worker exited without a result."));
    });
  });
}

// Importing the GUI inside another worker must not claim its parent channel.
if (!isMainThread && workerData?.kind === GUI_TASK_KIND) {
  try {
    const task = workerData.task;
    let value;
    if (task?.operation === "run") {
      const options = task.options ?? {};
      const python = options.python ?? selectPython();
      value = await runDemo(task.args, { ...options, python });
    } else if (task?.operation === "replay") {
      value = replayBundle(task.bundle, task.options ?? {});
    } else {
      throw new Error("Unsupported GUI worker operation.");
    }
    parentPort.postMessage({ ok: true, value });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.message });
  } finally {
    parentPort.close();
  }
}
