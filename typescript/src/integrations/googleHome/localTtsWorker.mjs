import { parentPort, workerData } from "node:worker_threads";
import text2wav from "text2wav";

if (parentPort) {
  const audio = await text2wav(workerData.message, {
    voice: workerData.voice,
    speed: 165,
    // Do not pass `amplitude`: with text2wav 0.0.14 any amplitude value yields
    // all-zero (silent) audio. Loudness is set by the Cast volume instead.
    noFinalPause: true,
  });
  parentPort.postMessage(audio);
  parentPort.close();
}
