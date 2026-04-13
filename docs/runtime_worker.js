import { ChorusBrowserRuntime } from "./shared/browser_runtime_loader.js";

const runtimeSession = {
    runtime: null,
    handle: null,
};

function configureRealtimeTemporalMode() {
    if (!runtimeSession.runtime || !runtimeSession.handle) {
        return;
    }
    runtimeSession.runtime.exports.chorus_browser_runtime_set_temporal_mode?.(runtimeSession.handle, 1);
    runtimeSession.runtime.exports.chorus_browser_runtime_set_realtime_fps?.(runtimeSession.handle, 60.0);
}

async function ensureRuntimeLoaded() {
    if (runtimeSession.runtime && runtimeSession.handle) {
        return;
    }

    const wasmUrl = new URL("./shared/chorus_browser_runtime.wasm", import.meta.url);
    runtimeSession.runtime = await ChorusBrowserRuntime.load(wasmUrl, {
        env: {
            chorus_browser_stream_stdout(ptr, len) {
                const text = runtimeSession.runtime?.readText(ptr, len) ?? "";
                if (text) {
                    self.postMessage({ type: "stdout", text });
                }
            },
            chorus_browser_stream_stderr(ptr, len) {
                const text = runtimeSession.runtime?.readText(ptr, len) ?? "";
                if (text) {
                    self.postMessage({ type: "stderr", text });
                }
            },
            chorus_browser_blocking_sleep_ms(milliseconds) {
                const timeout = Number(milliseconds);
                if (!(timeout > 0)) {
                    return;
                }

                if (typeof SharedArrayBuffer === "function" && typeof Atomics?.wait === "function" && self.crossOriginIsolated) {
                    const shared = new SharedArrayBuffer(4);
                    const view = new Int32Array(shared);
                    Atomics.wait(view, 0, 0, timeout);
                    return;
                }

                const deadline = performance.now() + timeout;
                while (performance.now() < deadline) {
                }
            },
        },
    });
    runtimeSession.handle = runtimeSession.runtime.createHandle();
    configureRealtimeTemporalMode();
}

async function runSource(source) {
    await ensureRuntimeLoaded();
    self.postMessage({ type: "run-start" });
    runtimeSession.runtime.reset(runtimeSession.handle);
    configureRealtimeTemporalMode();
    runtimeSession.runtime.loadSource(runtimeSession.handle, source, "<browser-web-pub>");
    runtimeSession.runtime.run(runtimeSession.handle);
    const state = runtimeSession.runtime.readState(runtimeSession.handle);
    self.postMessage({ type: "result", state });
}

self.addEventListener("message", async (event) => {
    const { data } = event;
    try {
        switch (data?.type) {
        case "init":
            await ensureRuntimeLoaded();
            self.postMessage({ type: "ready" });
            break;
        case "run":
            await runSource(String(data.source ?? ""));
            break;
        default:
            break;
        }
    } catch (error) {
        self.postMessage({
            type: "worker-error",
            message: error?.message || String(error),
        });
    }
});
