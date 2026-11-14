function abortError(signal) {
    return signal?.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("Queued task was cancelled"), { code: "PROCESS_CANCELLED" });
}

export class JobQueue {
    #concurrency;
    #tasks = [];
    #running = 0;
    #idleWaiters = [];

    constructor(concurrency) {
        if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
            throw new TypeError("concurrency must be a positive safe integer");
        }
        this.#concurrency = concurrency;
    }

    get size() { return this.#tasks.length; }
    get pending() { return this.#running; }

    add(run, { signal } = {}) {
        if (typeof run !== "function") return Promise.reject(new TypeError("task must be a function"));
        if (signal?.aborted) return Promise.reject(abortError(signal));

        return new Promise((resolve, reject) => {
            const task = { run, signal, resolve, reject, state: "queued", onAbort: null };
            task.onAbort = () => {
                if (task.state !== "queued") return;
                const index = this.#tasks.indexOf(task);
                if (index !== -1) this.#tasks.splice(index, 1);
                task.state = "settled";
                reject(abortError(signal));
                this.#notifyIdle();
            };
            signal?.addEventListener("abort", task.onAbort, { once: true });
            this.#tasks.push(task);
            this.#drain();
        });
    }

    onIdle() {
        if (this.#running === 0 && this.#tasks.length === 0) return Promise.resolve();
        return new Promise(resolve => this.#idleWaiters.push(resolve));
    }

    #drain() {
        while (this.#running < this.#concurrency && this.#tasks.length > 0) {
            const task = this.#tasks.shift();
            if (task.state !== "queued") continue;
            task.state = "running";
            task.signal?.removeEventListener("abort", task.onAbort);
            if (task.signal?.aborted) {
                task.state = "settled";
                task.reject(abortError(task.signal));
                continue;
            }

            this.#running++;
            Promise.resolve()
                .then(() => task.run({ signal: task.signal }))
                .then(task.resolve, task.reject)
                .finally(() => {
                    task.state = "settled";
                    this.#running--;
                    this.#drain();
                    this.#notifyIdle();
                });
        }
        this.#notifyIdle();
    }

    #notifyIdle() {
        if (this.#running !== 0 || this.#tasks.length !== 0) return;
        for (const resolve of this.#idleWaiters.splice(0)) resolve();
    }
}
