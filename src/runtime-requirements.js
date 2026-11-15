const MINIMUM_NODE_VERSION = [22, 15, 0];

export function isSupportedNodeVersion(version) {
    const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
    if (!match) return false;
    const actual = match.slice(1).map(Number);
    for (let index = 0; index < MINIMUM_NODE_VERSION.length; index++) {
        if (actual[index] > MINIMUM_NODE_VERSION[index]) return true;
        if (actual[index] < MINIMUM_NODE_VERSION[index]) return false;
    }
    return true;
}

export function assertSupportedNodeVersion(version = process.versions.node) {
    if (!isSupportedNodeVersion(version)) {
        throw new Error("YT-DLP API requires Node.js >=22.15.0 (node:sqlite DatabaseSync.isOpen)");
    }
}
