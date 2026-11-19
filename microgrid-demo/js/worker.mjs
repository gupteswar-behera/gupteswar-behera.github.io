// Runs the solver off the main thread, so the page stays responsive during a solve.
import Module from "../vendor/highs.mjs";
import { solveWindow } from "./milp.mjs";

const load = () => Module({ locateFile: (file) => new URL(`../vendor/${file}`, import.meta.url).href });
let highs = null;
let latest = 0;

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

self.onmessage = async ({ data }) => {
  const { token, jobs, win, d } = data;
  latest = token;
  try {
    if (!highs) highs = await load();
  } catch (error) {
    self.postMessage({ token, failed: String(error) });
    return;
  }
  for (const job of jobs) {
    await pause(); // lets a newer request arrive and replace this one
    if (token !== latest) return;
    const start = performance.now();
    try {
      const result = solveWindow(highs, job.win ?? win, job.units, job.d ?? d);
      self.postMessage({ token, name: job.name, result, ms: performance.now() - start });
    } catch (error) {
      highs = await load(); // a failed WebAssembly solve leaves the instance unusable
      self.postMessage({ token, name: job.name, failed: String(error) });
    }
  }
};
