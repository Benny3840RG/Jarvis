import { createPersistenceFromEnv } from "./persistence/persistence.js";
import { fileURLToPath } from "url";
import path from "path";

export async function status() {
  const provider = createPersistenceFromEnv();
  const state = await provider.loadState();
  console.log("Jarvis (TS) is working.");
  console.log("State keys:", Object.keys(state));
}

export async function saveNote(text: string) {
  const provider = createPersistenceFromEnv();
  const state = await provider.loadState();
  const notes = (state.notes as string[]) ?? [];
  notes.push(text);
  state.notes = notes;
  await provider.saveState(state);
}

export async function listNotes() {
  const provider = createPersistenceFromEnv();
  const state = await provider.loadState();
  return (state.notes as string[]) ?? [];
}
