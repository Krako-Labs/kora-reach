import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "kora-reach-file-demo-"));
await writeFile(path.join(root, "photo-a.jpg"), "same-image-bytes\n");
await writeFile(path.join(root, "photo-copy.jpg"), "same-image-bytes\n");
await writeFile(path.join(root, "notes.txt"), "notes\n");
await writeFile(path.join(root, "data.csv"), "id,name\n1,kora\n");
console.log(root);
