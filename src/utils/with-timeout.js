export function withTimeout(operation, timeoutMs, onTimeout = () => {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new TypeError("timeoutMs must be a positive safe integer");
    }

    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = Object.assign(new Error("Operation exceeded its time limit"), {
                code: "OPERATION_TIMEOUT"
            });
            try {
                onTimeout(error);
            } finally {
                reject(error);
            }
        }, timeoutMs);
    });

    return Promise.race([Promise.resolve().then(operation), deadline])
        .finally(() => clearTimeout(timer));
}
