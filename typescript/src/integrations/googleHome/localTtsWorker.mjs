import { parentPort, workerData } from "node:worker_threads";
import text2wav from "text2wav";

if (parentPort) {
  const audio = await text2wav(workerData.message, {
    voice: workerData.voice,
    speed: 165,
    amplitude: 110,
    noFinalPause: true,
  });
  parentPort.postMessage(audio);
  parentPort.close();
}
