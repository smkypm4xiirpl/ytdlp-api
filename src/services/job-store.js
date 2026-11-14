import fs from "node:fs";
import path from "node:path";
import config from "../config.js";
import { openSqliteJobStore } from "./sqlite-store-core.js";

export const databasePath = path.join(path.dirname(config.storagePath), "jobs.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const store = openSqliteJobStore(databasePath, {
    lockPath: path.join(path.dirname(databasePath), ".ytdlp-api.lock")
});
export const saveJob = (job) => store.saveJob(job);
export const getStoredJob = (id) => store.getStoredJob(id);
export const listStoredJobs = () => store.listStoredJobs();
export const deleteStoredJob = (id) => store.deleteStoredJob(id);
export const closeJobStore = () => store.close();
