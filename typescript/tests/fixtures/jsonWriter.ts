import { JSONPersistence } from "../../src/persistence/persistence.js";

const [file, title] = process.argv.slice(2);
if (!file || !title) throw new Error("JSON writer fixture requires a file and title.");

await new JSONPersistence(file).addTask(title, "personal");
