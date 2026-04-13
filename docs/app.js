import {
    formatStatus,
    safeLocalStorageGet,
    safeLocalStorageSet,
    setText,
} from "./shared/browser_shell_shared.js";

const STORAGE_KEYS = {
    source: "chorus.browser.web-pub.minimal.source.v4",
    theme: "chorus.browser.web-pub.minimal.theme.v4",
};

const DEFAULT_SOURCE = `Answer := 10
Print("Hello Chorus!")
Answer
`;

const KEYWORDS = new Set([
    "if", "else", "for", "while", "loop", "return", "break", "continue", "case", "of",
    "set", "var", "module", "using", "where", "defer", "spawn", "sync", "race", "rush",
    "await", "upon", "when", "yield", "logic", "option", "array", "map", "class", "struct",
    "interface", "enum", "type", "Self", "self", "true", "false"
]);

const TYPE_LIKE = new Set([
    "int", "float", "rational", "string", "char", "char32", "logic", "void", "type"
]);

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function joinOutput(state) {
    const parts = [];
    if (state.stdout) parts.push(state.stdout.trimEnd());
    if (state.stderr) parts.push(state.stderr.trimEnd());
    if (state.error) parts.push(state.error.trimEnd());
    return parts.filter(Boolean).join("\n\n") || "(empty)";
}

function formatStatusTimestamp(date = new Date()) {
    return date.toLocaleTimeString([], { hour12: false });
}

function setStatus(nodes, message) {
    setText(nodes.statusTime, formatStatusTimestamp());
    setText(nodes.statusText, message);
}

function nextPaint() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
        });
    });
}

function renderStatus(state) {
    let status = formatStatus(state);
    if (state.incomplete) {
        status += ` · waiting on ${state.waitReasonName}`;
    }
    return status;
}

async function loadVersionText() {
    const candidates = ["./CHORUSVERSION", "../../CHORUSVERSION"];
    for (const url of candidates) {
        try {
            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) continue;
            const text = (await response.text()).trim();
            if (text) return text;
        } catch (_error) {
        }
    }
    return "";
}

function renderVersion(nodes, versionText) {
    const normalized = String(versionText || "").trim();
    if (!normalized) {
        setText(nodes.versionNote, "");
        return;
    }
    setText(nodes.versionNote, normalized.replace(/^[vV](?=\d)/, ""));
}

function tokenizeLine(line) {
    const tokens = [];
    let i = 0;

    while (i < line.length) {
        const rest = line.slice(i);

        if (rest.startsWith("#")) {
            tokens.push({ type: "comment", text: rest });
            break;
        }

        const stringMatch = rest.match(/^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/);
        if (stringMatch) {
            tokens.push({ type: "string", text: stringMatch[1] });
            i += stringMatch[1].length;
            continue;
        }

        const numberMatch = rest.match(/^(?:0x[0-9A-Fa-f]+|\d+(?:\.\d+)?)/);
        if (numberMatch) {
            tokens.push({ type: "number", text: numberMatch[0] });
            i += numberMatch[0].length;
            continue;
        }

        const wordMatch = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (wordMatch) {
            const word = wordMatch[0];
            let type = "plain";
            if (KEYWORDS.has(word)) type = "keyword";
            else if (TYPE_LIKE.has(word)) type = "type";
            tokens.push({ type, text: word });
            i += word.length;
            continue;
        }

        const operatorMatch = rest.match(/^(?:=>|:=|<=|>=|<>|=|\+|\-|\*|\/|\.|,|:|\(|\)|\[|\]|\{|\}|<|>|\?)/);
        if (operatorMatch) {
            tokens.push({ type: "operator", text: operatorMatch[0] });
            i += operatorMatch[0].length;
            continue;
        }

        tokens.push({ type: "plain", text: line[i] });
        i += 1;
    }

    return tokens;
}

function highlightSource(source) {
    const normalized = source.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    return lines.map((line) => tokenizeLine(line).map((token) => {
        const escaped = escapeHtml(token.text);
        if (token.type === "plain") return escaped;
        return `<span class="tok-${token.type}">${escaped}</span>`;
    }).join("")).join("\n");
}

function buildLineNumberText(source) {
    const normalized = source.replace(/\r\n/g, "\n");
    const lineCount = Math.max(1, normalized.split("\n").length);
    return Array.from({ length: lineCount }, (_value, index) => String(index + 1)).join("\n");
}

function syncEditorScroll(nodes) {
    nodes.highlight.scrollTop = nodes.source.scrollTop;
    nodes.highlight.scrollLeft = nodes.source.scrollLeft;
    nodes.lineNumbers.scrollTop = nodes.source.scrollTop;
}

function applyTheme(theme, nodes) {
    const normalized = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", normalized);
    nodes.themeToggle.textContent = normalized === "dark" ? "Light" : "Dark";
    safeLocalStorageSet(STORAGE_KEYS.theme, normalized);
}

function renderHighlightedSource(nodes) {
    const source = nodes.source.value || "";
    nodes.highlight.innerHTML = `${highlightSource(source)}\n`;
    setText(nodes.lineNumbers, buildLineNumberText(source));
    syncEditorScroll(nodes);
}

function renderIdle(nodes, statusText = "Ready") {
    setText(nodes.value, "(empty)");
    setText(nodes.output, "(empty)");
    setStatus(nodes, statusText);
}

async function main() {
    const nodes = {
        source: document.querySelector("#source"),
        highlight: document.querySelector("#highlight"),
        lineNumbers: document.querySelector("#line-numbers"),
        run: document.querySelector("#run"),
        value: document.querySelector("#value"),
        output: document.querySelector("#output"),
        statusTime: document.querySelector("#status-time"),
        statusText: document.querySelector("#status-text"),
        themeToggle: document.querySelector("#theme-toggle"),
        versionNote: document.querySelector("#version-note"),
    };

    nodes.source.value = safeLocalStorageGet(STORAGE_KEYS.source) ?? DEFAULT_SOURCE;
    applyTheme(safeLocalStorageGet(STORAGE_KEYS.theme) ?? "light", nodes);
    renderHighlightedSource(nodes);
    renderVersion(nodes, await loadVersionText());
    renderIdle(nodes, "Loading…");
    nodes.run.disabled = true;

    const workerSession = {
        worker: null,
        ready: false,
        running: false,
        pendingRun: false,
        stdout: "",
        stderr: "",
        error: "",
        value: "",
    };

    const refreshStreamingOutput = () => {
        setText(nodes.output, joinOutput(workerSession));
    };

    const disposeRuntime = () => {
        if (workerSession.worker) {
            workerSession.worker.terminate();
        }
        workerSession.worker = null;
        workerSession.ready = false;
        workerSession.running = false;
        workerSession.pendingRun = false;
        nodes.run.disabled = true;
    };

    const runCurrentSource = async () => {
        safeLocalStorageSet(STORAGE_KEYS.source, nodes.source.value);
        renderHighlightedSource(nodes);

        if (!workerSession.worker || !workerSession.ready) {
            setStatus(nodes, "Runtime not loaded yet.");
            return;
        }
        if (workerSession.running) {
            return;
        }

        workerSession.stdout = "";
        workerSession.stderr = "";
        workerSession.error = "";
        workerSession.value = "";
        workerSession.running = true;
        workerSession.pendingRun = true;
        setText(nodes.value, "(empty)");
        setText(nodes.output, "(empty)");
        nodes.run.disabled = true;
        setStatus(nodes, "Running…");
        await nextPaint();
        workerSession.worker.postMessage({
            type: "run",
            source: nodes.source.value,
        });
    };

    nodes.source.addEventListener("input", () => {
        safeLocalStorageSet(STORAGE_KEYS.source, nodes.source.value);
        renderHighlightedSource(nodes);
    });
    nodes.source.addEventListener("scroll", () => syncEditorScroll(nodes));
    nodes.source.addEventListener("keydown", (event) => {
        if (event.key === "Tab") {
            event.preventDefault();
            const start = nodes.source.selectionStart;
            const end = nodes.source.selectionEnd;
            nodes.source.setRangeText("    ", start, end, "end");
            safeLocalStorageSet(STORAGE_KEYS.source, nodes.source.value);
            renderHighlightedSource(nodes);
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            runCurrentSource();
        }
    });

    nodes.run.addEventListener("click", runCurrentSource);
    nodes.themeToggle.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
        applyTheme(current === "dark" ? "light" : "dark", nodes);
    });

    if (window.location.protocol === "file:") {
        renderIdle(nodes, "Open this shell over HTTP(S).");
        return;
    }

    try {
        const worker = new Worker(new URL("./runtime_worker.js", import.meta.url), { type: "module" });
        workerSession.worker = worker;
        worker.addEventListener("message", (event) => {
            const { data } = event;
            switch (data?.type) {
            case "ready":
                workerSession.ready = true;
                nodes.run.disabled = false;
                renderIdle(nodes, "Ready");
                runCurrentSource();
                break;
            case "run-start":
                workerSession.running = true;
                workerSession.pendingRun = false;
                break;
            case "stdout":
                workerSession.stdout += String(data.text || "");
                refreshStreamingOutput();
                break;
            case "stderr":
                workerSession.stderr += String(data.text || "");
                refreshStreamingOutput();
                break;
            case "result": {
                workerSession.running = false;
                workerSession.pendingRun = false;
                const state = data.state || {};
                setText(nodes.value, state.value || "(empty)");
                workerSession.stdout = String(state.stdout || workerSession.stdout || "");
                workerSession.stderr = String(state.stderr || workerSession.stderr || "");
                workerSession.error = String(state.error || "");
                refreshStreamingOutput();
                setStatus(nodes, renderStatus(state));
                nodes.run.disabled = false;
                break;
            }
            case "worker-error":
                workerSession.running = false;
                workerSession.pendingRun = false;
                setText(nodes.value, "(empty)");
                workerSession.error = String(data.message || "Unknown worker error");
                refreshStreamingOutput();
                setStatus(nodes, `Failed: ${workerSession.error}`);
                nodes.run.disabled = false;
                break;
            default:
                break;
            }
        });
        worker.postMessage({ type: "init" });
    } catch (error) {
        disposeRuntime();
        renderIdle(nodes, `Runtime load failed: ${error.message}`);
        setText(nodes.output, error.message || "(empty)");
    }
}

main();
