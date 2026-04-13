import { ChorusBrowserRuntime, browserExamples } from "./browser_runtime_loader.js";

const wasmUrl = new URL("./chorus_browser_runtime.wasm", import.meta.url);

const SOURCE_REVIEW_RULES = [
    {
        severity: "blocked",
        pattern: /\bReadLine\s*\(/,
        message: "ReadLine() requires console input, and the browser host denies console-input capability.",
    },
    {
        severity: "blocked",
        pattern: /\b(?:io|http|os|process|socket|sqlite|ffi|path)\s*\./i,
        message: "This source appears to call a native stdlib surface that depends on host capabilities outside BrowserMinimal.",
    },
    {
        severity: "warn",
        pattern: /\b(?:NextTick|NextFrame|WaitTicks|WaitFrames|Sleep)\b/,
        message: "Deterministic tick, frame, and sleep waits are supported in the browser runtime, but external-event waits and full interactive temporal tooling are still outside the current contract.",
    },
    {
        severity: "warn",
        pattern: /\b(?:LoadLibrary|NativeInterop)\b/,
        message: "Native interop is not part of the browser runtime contract.",
    },
];

export { browserExamples };

export function setText(node, text) {
    if (node) {
        node.textContent = text;
    }
}

export function safeLocalStorageGet(key) {
    try {
        return window.localStorage.getItem(key);
    } catch (_error) {
        return null;
    }
}

export function safeLocalStorageSet(key, value) {
    try {
        window.localStorage.setItem(key, value);
    } catch (_error) {
        // Storage can be unavailable in some privacy contexts; the browser shell still works.
    }
}

export function formatStatus(state) {
    if (state.incomplete) {
        return `Incomplete: waiting on ${state.waitReasonName}`;
    }
    if (!state.ok) {
        return `Failed: ${state.error || "unknown browser runtime error"}`;
    }
    return "Completed successfully";
}

export function describePageMode() {
    return window.location.protocol === "file:" ? "Direct file-open (unsupported)" : "Static hosting";
}

export function analyzeSourceSupport(sourceText) {
    const findings = [];
    for (const rule of SOURCE_REVIEW_RULES) {
        if (rule.pattern.test(sourceText)) {
            findings.push({ severity: rule.severity, message: rule.message });
        }
    }

    const hasBlocked = findings.some((finding) => finding.severity === "blocked");
    const hasWarnings = findings.some((finding) => finding.severity === "warn");

    let summary = "Looks compatible with the current browser subset.";
    let summaryClass = "good";

    if (hasBlocked) {
        summary = "This source likely depends on unsupported native/browser-host surfaces.";
        summaryClass = "blocked";
    } else if (hasWarnings) {
        summary = "This source may run into partial browser-runtime coverage or more advanced temporal/task surfaces.";
        summaryClass = "warn";
    }

    return { summary, summaryClass, findings };
}

export function populateExamples(select, exampleEntries = Object.entries(browserExamples)) {
    select.replaceChildren();
    for (const [key, example] of exampleEntries) {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = example.label;
        select.appendChild(option);
    }
}

export function getExampleByKey(key, fallbackKey = "arithmetic") {
    return browserExamples[key] ?? browserExamples[fallbackKey] ?? Object.values(browserExamples)[0];
}

export async function loadBundledRuntime() {
    return ChorusBrowserRuntime.load(wasmUrl);
}
