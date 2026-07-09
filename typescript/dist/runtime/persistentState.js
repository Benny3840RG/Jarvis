import * as fs from "node:fs";
import * as path from "node:path";
export class PersistentState {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
    }
    load() {
        if (!fs.existsSync(this.filePath)) {
            return null;
        }
        const raw = fs.readFileSync(this.filePath, "utf8");
        return JSON.parse(raw);
    }
    save(data) {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    }
}
