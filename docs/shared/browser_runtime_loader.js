const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8");

const WASI_ERRNO = {
    ESUCCESS: 0,
    EBADF: 8,
    EFAULT: 21,
    EINVAL: 28,
    ENOSYS: 52,
};

const WAIT_REASON_NAMES = [
    "None",
    "AwaitTask",
    "NextTick",
    "NextFrame",
    "SleepUntil",
    "HostEvent",
    "Event",
    "PlaceholderDependency",
];

export const browserExamples = {
    arithmetic: {
        label: "Arithmetic",
        description: "Small pure-value smoke test for the current browser subset.",
        source: `Answer := 1 + 2 * 3
Answer
`,
    },
    functions: {
        label: "Functions",
        description: "Named function definition and call through the browser-hosted runtime.",
        source: `Add(X:int, Y:int):int = X + Y
Add(3, 4)
`,
    },
    closure: {
        label: "Closure",
        description: "Closure capture is part of the safe pure-language browser lane.",
        source: `MakeAdder(N:int):type{_(int):int} = (X:int):int => X + N
Add5 := MakeAdder(5)
Add5(3)
`,
    },
    controlFlow: {
        label: "Control flow",
        description: "Simple branching stays inside the current browser-friendly surface.",
        source: `Result := if (3 > 1):
    10
else:
    20
Result
`,
    },
    containers: {
        label: "Containers",
        description: "Array and tuple-to-array flow using pure builtin/container behavior.",
        source: `Numbers:[]int = array{1, 2} + (3, 4)
Append(Numbers, 5)
`,
    },
    print: {
        label: "Print",
        description: "Shows stdout capture through the browser host contract.",
        source: `Print("browser-ok")
`,
    },
    inputDenied: {
        label: "Unsupported: console input",
        description: "Demonstrates truthful denied-capability messaging for ReadLine().",
        source: `Answer := ReadLine("")
Print(Answer)
`,
    },
    temporalProgression: {
        label: "Temporal progression",
        description: "Deterministic tick, frame, and sleep waits now advance through the browser-hosted runtime without pretending full host-event parity.",
        source: `Print("tick-start")
NextTick()
Print("after-next-tick")
WaitTicks(2)
Print("after-wait-ticks")
NextFrame()
Print("after-next-frame")
WaitFrames(2)
Print("after-wait-frames")
Sleep(0.001)
Print("after-sleep")
42
`,
    },
    taskTemporal: {
        label: "Task + sleep",
        description: "A spawned task can suspend on Sleep() and still complete truthfully inside the browser scheduler.",
        source: `Worker := spawn:
    Sleep(0.001)
    42
Worker.Await()
`,
    },
};

export class ChorusBrowserRuntime {
    constructor(exports) {
        this.exports = exports;
        if (!this.exports.memory) {
            throw new Error("browser runtime did not export linear memory");
        }
    }

    static async load(wasmUrl, imports = {}) {
        const response = await fetch(wasmUrl);
        if (!response.ok) {
            throw new Error(`failed to fetch browser runtime wasm: ${response.status} ${response.statusText}`);
        }
        return ChorusBrowserRuntime.loadFromBytes(await response.arrayBuffer(), imports);
    }

    static async loadFromBytes(bytes, imports = {}) {
        const instantiation = createBrowserRuntimeImports(imports);
        const { instance } = await WebAssembly.instantiate(bytes, instantiation.imports);
        instantiation.bindMemory(instance.exports.memory);
        return new ChorusBrowserRuntime(instance.exports);
    }

    get memory() {
        const memory = this.exports.memory;
        if (!memory) {
            throw new Error("browser runtime memory export is missing");
        }
        return memory;
    }

    createHandle() {
        const handle = this.exports.chorus_browser_runtime_create();
        if (!handle) {
            throw new Error("failed to allocate a browser runtime handle");
        }
        return handle;
    }

    destroyHandle(handle) {
        if (handle) {
            this.exports.chorus_browser_runtime_destroy(handle);
        }
    }

    reset(handle) {
        if (!handle) {
            throw new Error("browser runtime handle is null");
        }
        this.exports.chorus_browser_runtime_reset(handle);
    }

    allocateBytes(bytes) {
        if (bytes.length === 0) {
            return 0;
        }
        const ptr = this.exports.chorus_browser_alloc(bytes.length);
        if (!ptr) {
            throw new Error("browser runtime memory allocation failed");
        }
        new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
        return ptr;
    }

    freeBytes(ptr) {
        if (ptr) {
            this.exports.chorus_browser_free(ptr);
        }
    }

    readText(ptr, len) {
        if (!ptr || !len) {
            return "";
        }
        return TEXT_DECODER.decode(new Uint8Array(this.memory.buffer, ptr, len));
    }

    readState(handle) {
        if (!handle) {
            throw new Error("browser runtime handle is null");
        }

        const waitReasonKind = Number(this.exports.chorus_browser_runtime_last_wait_reason_kind(handle));
        return {
            ok: this.exports.chorus_browser_runtime_last_ok(handle) === 1,
            incomplete: this.exports.chorus_browser_runtime_last_incomplete(handle) === 1,
            waitReasonKind,
            waitReasonName: WAIT_REASON_NAMES[waitReasonKind] ?? "Unknown",
            currentTick: String(this.exports.chorus_browser_runtime_current_tick(handle)),
            currentFrame: String(this.exports.chorus_browser_runtime_current_frame(handle)),
            stdout: this.readText(
                this.exports.chorus_browser_runtime_stdout_ptr(handle),
                this.exports.chorus_browser_runtime_stdout_len(handle)
            ),
            stderr: this.readText(
                this.exports.chorus_browser_runtime_stderr_ptr(handle),
                this.exports.chorus_browser_runtime_stderr_len(handle)
            ),
            error: this.readText(
                this.exports.chorus_browser_runtime_error_ptr(handle),
                this.exports.chorus_browser_runtime_error_len(handle)
            ),
            value: this.readText(
                this.exports.chorus_browser_runtime_value_ptr(handle),
                this.exports.chorus_browser_runtime_value_len(handle)
            ),
        };
    }

    loadSource(handle, source, virtualPath = "<browser>") {
        if (!handle) {
            throw new Error("browser runtime handle is null");
        }

        const sourceBytes = TEXT_ENCODER.encode(String(source));
        const pathBytes = TEXT_ENCODER.encode(String(virtualPath));
        const sourcePtr = this.allocateBytes(sourceBytes);
        const pathPtr = this.allocateBytes(pathBytes);

        try {
            const ok = this.exports.chorus_browser_runtime_set_source(
                handle,
                sourcePtr,
                sourceBytes.length,
                pathPtr,
                pathBytes.length
            );
            if (ok !== 1) {
                throw new Error(this.readState(handle).error || "browser runtime rejected source text");
            }
        } finally {
            this.freeBytes(pathPtr);
            this.freeBytes(sourcePtr);
        }
    }

    run(handle) {
        if (!handle) {
            throw new Error("browser runtime handle is null");
        }
        return this.exports.chorus_browser_runtime_run(handle) === 1;
    }

    runSource(source, virtualPath = "<browser>") {
        const handle = this.createHandle();
        try {
            this.loadSource(handle, source, virtualPath);
            this.run(handle);
            return this.readState(handle);
        } finally {
            this.destroyHandle(handle);
        }
    }
}

function createBrowserRuntimeImports(overrides = {}) {
    let memory = null;

    const getMemory = () => memory;
    const wasi = {
        clock_time_get(clockId, precision, resultPtr) {
            void clockId;
            void precision;
            const currentMemory = getMemory();
            if (!currentMemory) {
                return WASI_ERRNO.ENOSYS;
            }

            const view = new DataView(currentMemory.buffer);
            const nowNs = BigInt(Math.floor(Date.now() * 1_000_000));
            view.setBigUint64(resultPtr, nowNs, true);
            return WASI_ERRNO.ESUCCESS;
        },

        fd_close(fd) {
            void fd;
            return WASI_ERRNO.ESUCCESS;
        },

        fd_seek(fd, offsetLow, offsetHigh, whence, resultPtr) {
            void offsetLow;
            void offsetHigh;
            void whence;
            const currentMemory = getMemory();
            if (!currentMemory) {
                return WASI_ERRNO.ENOSYS;
            }

            const view = new DataView(currentMemory.buffer);
            if (fd === 0 || fd === 1 || fd === 2) {
                view.setBigUint64(resultPtr, 0n, true);
                return WASI_ERRNO.ESUCCESS;
            }
            return WASI_ERRNO.EBADF;
        },

        fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
            const currentMemory = getMemory();
            if (!currentMemory) {
                return WASI_ERRNO.ENOSYS;
            }

            const view = new DataView(currentMemory.buffer);
            const bytes = new Uint8Array(currentMemory.buffer);
            let written = 0;
            const chunks = [];

            for (let i = 0; i < iovsLen; ++i) {
                const iovPtr = iovsPtr + (i * 8);
                const bufPtr = view.getUint32(iovPtr, true);
                const bufLen = view.getUint32(iovPtr + 4, true);
                if (bufLen === 0) {
                    continue;
                }

                chunks.push(TEXT_DECODER.decode(bytes.subarray(bufPtr, bufPtr + bufLen)));
                written += bufLen;
            }

            if (nwrittenPtr) {
                view.setUint32(nwrittenPtr, written, true);
            }

            if (fd === 1) {
                console.log(chunks.join(""));
                return WASI_ERRNO.ESUCCESS;
            }
            if (fd === 2) {
                console.error(chunks.join(""));
                return WASI_ERRNO.ESUCCESS;
            }
            return WASI_ERRNO.EBADF;
        },

        fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
            void iovsPtr;
            void iovsLen;
            const currentMemory = getMemory();
            if (!currentMemory) {
                return WASI_ERRNO.ENOSYS;
            }

            const view = new DataView(currentMemory.buffer);
            if (nreadPtr) {
                view.setUint32(nreadPtr, 0, true);
            }

            if (fd === 0) {
                return WASI_ERRNO.ESUCCESS;
            }
            return WASI_ERRNO.EBADF;
        },
    };

    const imports = {
        ...overrides,
        env: {
            chorus_browser_stream_stdout(ptr, len) {
                void ptr;
                void len;
            },
            chorus_browser_stream_stderr(ptr, len) {
                void ptr;
                void len;
            },
            ...(overrides.env ?? {}),
        },
        wasi_snapshot_preview1: {
            ...wasi,
            ...(overrides.wasi_snapshot_preview1 ?? {}),
        },
    };

    return {
        imports,
        bindMemory(nextMemory) {
            memory = nextMemory;
        },
    };
}
