import { app } from "../../scripts/app.js";

// Node Profiles: saves the settings of the nodes wired into its slots as named profiles, and restores them.
//
// Each slot follows its wire back to the one node the value comes from: through reroutes, out of a subgraph
// to whatever is connected to it outside, and into a subgraph from its output to the node inside that
// produces it. Every setting of that node is saved by name, along with whether it's active, bypassed or
// muted, and its title, color, size and collapsed state. The toggles on the node decide which of those last
// four are put back when a profile is loaded. A subgraph's own settings are never saved: a setting of a node
// inside a subgraph that's shown as a field on the subgraph's outside is saved and restored through that
// field, since that's where its value is kept.
//
// Profiles are kept inside the node, so they're saved with the workflow.

const NODE_TYPE = "Node Profiles";
const NODE_TITLE = "Node Profiles";
const LOG_PREFIX = "[Node Profiles]";

// Writes each step of loading a profile to the browser console, to help find problems with nodes that change
// their own settings. Only setting names and timings are written, never their values, which can be private.
const DEBUG = false;

// After loading a profile, the settings are checked for a moment, in case the node changes them by itself, or
// loads a dropdown's choices, a moment after a setting changes. All times are in milliseconds.
// How often to check.
const SETTLE_STEP_MS = 250;
// Once everything matches, how long to keep watching for late changes before stopping.
const WATCH_AFTER_MATCH_MS = 1000;
// The longest to keep checking when things still don't match. A pop-up then lists what didn't.
const SETTLE_TIME_MS = 3000;
// How many checks in a row everything has to match before the node is told about every setting once more.
const SETTLED_CHECKS = 1;

// If a dropdown's value still isn't among its choices after this long, every setting is set again.
const SETTLE_RETRY_MS = 500;

// The most times the node is told about every setting again, while checking.
const MAX_TELL_AGAIN = 3;

// The node always has at least this many slots. One more is added whenever the last one is connected.
const MIN_SLOTS = 2;
const SLOT_PREFIX = "slot_";

// Shown in the profile list when there are no profiles yet. It can't be used as a profile name.
const NO_PROFILE = "(no profiles)";

// The id ComfyUI gives a subgraph's inputs when a wire inside the subgraph starts from one of them.
const SUBGRAPH_INPUT_ID = -10;

function startsAtSubgraphInput(link) {
    // ComfyUI may store the id as the number -10 or as the text "-10", so both are accepted.
    return String(link?.origin_id) === String(SUBGRAPH_INPUT_ID);
}

// How many reroutes and subgraph boundaries a wire is followed through before giving up.
const MAX_STEPS = 100;

// How much wider than the smallest size a new node starts, to leave room for longer profile names.
const START_WIDTH_FACTOR = 1.75;

// A toggle, on by default, that skips checking the settings after loading, so loading is done at once. Turning it
// off is for nodes that change their own settings, or load their choices late, after a profile is loaded.
const FAST_LOAD = "fast load";
const FAST_LOAD_TOOLTIP =
    "Loads at once, without checking that every setting stuck. Turn off if a node doesn't fully load correctly.";

const TOGGLES = [
    { name: "restore title", key: "title" },
    { name: "restore color", key: "color" },
    { name: "restore size", key: "size" },
    { name: "restore collapsed", key: "collapsed" },
];

// ---------------------------------------------------------------------------------------------------------
// Finding nodes and wires

function nodesIn(graph) {
    return graph?.nodes || graph?._nodes || [];
}

function findLink(graph, linkId) {
    if (typeof graph?.getLink === "function") {
        const link = graph.getLink(linkId);
        if (link) {
            return link;
        }
    }
    const links = graph?.links || graph?._links;
    if (!links) {
        return null;
    }
    if (typeof links.get === "function") {
        return links.get(linkId) || null;
    }
    return links[linkId] || null;
}

function findNode(graph, nodeId) {
    if (typeof graph?.getNodeById === "function") {
        return graph.getNodeById(nodeId);
    }
    return nodesIn(graph).find((node) => node.id === nodeId) || null;
}

function rootGraph() {
    return app.graph?.rootGraph || app.graph;
}

function findSubgraphNode(subgraph) {
    // The node on the outside of a subgraph, found by looking through the main graph and every subgraph in it.
    const pending = [rootGraph()];
    const seen = new Set();
    while (pending.length > 0) {
        const graph = pending.pop();
        if (!graph || seen.has(graph)) {
            continue;
        }
        seen.add(graph);
        for (const node of nodesIn(graph)) {
            if (node.subgraph === subgraph) {
                return node;
            }
            if (node.subgraph) {
                pending.push(node.subgraph);
            }
        }
    }
    return null;
}

function isReroute(node) {
    return node?.type === "Reroute";
}

function sourceOf(graph, linkId) {
    // Follows a wire back to where its value comes from. Returns one of:
    //   { node }: a node, whose settings are saved.
    //   { field: { node, widget } }: a single field on a subgraph's outside. This is when the wire starts at
    //       one of the subgraph's inputs inside it, and nothing is wired into that input outside.
    //   { error }
    for (let step = 0; step < MAX_STEPS; step++) {
        const link = findLink(graph, linkId);
        if (!link) {
            return { error: "its wire couldn't be found" };
        }

        if (startsAtSubgraphInput(link)) {
            // The wire starts at one of the subgraph's inputs: continue outside the subgraph.
            const outer = findSubgraphNode(graph);
            const input = outer?.inputs?.[link.origin_slot];
            if (!outer || !input) {
                return { error: "the subgraph it comes from couldn't be found" };
            }
            if (input.link == null) {
                // Nothing is wired into that input from outside, so its value is a field on the subgraph's outside.
                const widget = outerWidgetFor(outer, input);
                if (!widget) {
                    return { error: "the subgraph input it comes from has nothing connected and no field" };
                }
                return { field: holderOf({ node: outer, widget }) };
            }
            graph = outer.graph;
            linkId = input.link;
            continue;
        }

        const node = findNode(graph, link.origin_id);
        if (!node) {
            return { error: "the node it comes from couldn't be found" };
        }
        if (isReroute(node)) {
            const throughLink = node.inputs?.[0]?.link;
            if (throughLink == null) {
                return { error: "it goes to a reroute with nothing connected to it" };
            }
            linkId = throughLink;
            continue;
        }
        if (node.subgraph) {
            // The wire comes from a subgraph's output: continue inside, to what produces that output.
            const output = node.subgraph.outputs?.[link.origin_slot];
            const insideLink = output?.linkIds?.[0];
            if (insideLink == null) {
                return { error: "nothing inside the subgraph is connected to that output" };
            }
            graph = node.subgraph;
            linkId = insideLink;
            continue;
        }
        return { node };
    }
    return { error: "its wire goes around in a loop" };
}

function outerWidgetFor(outer, input) {
    // The field on a subgraph's outside that belongs to one of its inputs.
    const name = input.widget?.name ?? input.name;
    return (outer.widgets || []).find((widget) => widget.name === name) || null;
}

function holderOf(target) {
    // Where a field's value is really kept. A setting of a node inside a subgraph can be connected to one of
    // the subgraph's inputs and shown as a field on the subgraph's outside; then the value is kept in that
    // outside field, possibly through several subgraphs. Returns { node, widget }.
    for (let step = 0; step < MAX_STEPS; step++) {
        const { node, widget } = target;
        const input = (node.inputs || []).find((item) => item.widget?.name === widget.name && item.link != null);
        if (!input) {
            return target;
        }
        const link = findLink(node.graph, input.link);
        if (!link || !startsAtSubgraphInput(link)) {
            // Wired from another node, or not found: the setting's own value is used.
            return target;
        }
        const outer = findSubgraphNode(node.graph);
        const outerInput = outer?.inputs?.[link.origin_slot];
        if (!outer || !outerInput) {
            return target;
        }
        // Move out to the subgraph's field. If that field is itself passed on from a subgraph further out,
        // the next round follows it there.
        const outerWidget = outerWidgetFor(outer, outerInput);
        if (!outerWidget) {
            return target;
        }
        target = { node: outer, widget: outerWidget };
    }
    return target;
}

// ---------------------------------------------------------------------------------------------------------
// Saving and restoring

function copyOf(value) {
    try {
        return structuredClone(value);
    } catch {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return undefined;
        }
    }
}

function isSetting(widget) {
    return !!widget?.name && widget.type !== "button" && widget.serialize !== false;
}

function captureNode(node) {
    const settings = {};
    const choices = [];
    for (const widget of node.widgets || []) {
        if (!isSetting(widget)) {
            continue;
        }
        const holder = holderOf({ node, widget });
        const value = copyOf(holder.widget.value);
        if (value !== undefined) {
            settings[widget.name] = value;
            if (widget.type === "combo") {
                choices.push(widget.name);
            }
        }
    }
    return {
        type: node.type,
        settings,
        choices,
        mode: node.mode,
        title: node.title,
        color: node.color ?? null,
        bgcolor: node.bgcolor ?? null,
        size: node.size ? [node.size[0], node.size[1]] : null,
        collapsed: !!node.flags?.collapsed,
    };
}

function captureField(field) {
    // Only the one field's value: nothing about the subgraph it's on.
    return { field: field.widget.name, value: copyOf(field.widget.value) };
}

function choicesOf(widget, node) {
    let values = widget.options?.values;
    if (typeof values === "function") {
        try {
            values = values(widget, node);
        } catch {
            return null;
        }
    }
    return Array.isArray(values) ? values : null;
}

function debug(...args) {
    if (DEBUG) {
        console.log(LOG_PREFIX, ...args);
    }
}

function sameValue(a, b) {
    if (a === b) {
        return true;
    }
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

function available(node, widget, value) {
    // Whether a dropdown has this value among its choices. Anything that isn't a dropdown always can take it.
    if (widget.type !== "combo") {
        return true;
    }
    const choices = choicesOf(widget, node);
    return !choices || choices.includes(value);
}

function setValue(node, widget, value, restored, label) {
    // Puts a value back and remembers it in "restored", so it can be checked once the node has had time to react.
    const item = { node, widget, value, label, previous: copyOf(widget.value), waiting: false };
    restored.push(item);
    if (!available(node, widget, value)) {
        // The dropdown doesn't have this choice yet. Some nodes fill in a dropdown's choices a moment after
        // another setting changes, such as a folder setting that lists the images in that folder. The value is
        // put in place now, so the node sees it when its new choices arrive and keeps it, and the node is told
        // about it once it's among the choices.
        item.waiting = true;
        widget.value = copyOf(value);
        debug(`${label}: "${widget.name}" restored (not among its choices yet, waiting)`);
        return;
    }
    setAndTell(node, widget, value, label);
    debug(`${label}: "${widget.name}" restored`);
}

function setAndTell(node, widget, value, label) {
    widget.value = copyOf(value);
    try {
        // Lets the node react as if the value was picked by hand, such as Load Image showing the new image.
        widget.callback?.(widget.value, app.canvas, node);
    } catch (error) {
        console.warn(`${LOG_PREFIX} ${label}: "${widget.name}" was restored, but the node had trouble updating:`, error);
    }
}

function isTextSetting(widget) {
    // A box you type text into, not a dropdown.
    return isSetting(widget) && typeof widget.value === "string" && widget.type !== "combo";
}

function savedEntries(saved) {
    // The saved values of a slot as a list, whether it saved a whole node or a single field.
    if ("field" in saved) {
        return [{ name: saved.field, value: saved.value, isText: typeof saved.value === "string" }];
    }
    // Saved dropdown settings are listed in "choices", so they aren't mistaken for typed text.
    const choices = Array.isArray(saved.choices) ? saved.choices : [];
    return Object.entries(saved.settings || {}).map(([name, value]) => ({
        name,
        value,
        isText: typeof value === "string" && !choices.includes(name),
    }));
}

function restoreSlot(found, saved, restore, problems, restored, label) {
    // Puts a slot's saved values back into what the slot leads to now: a whole node, or a single field.
    // Values go to the setting with the same name. Saved text with no matching name goes into the remaining
    // text fields in order, first to first, so text still lands somewhere if the node was swapped for a
    // different kind. A warning is only given for saved values that end up with nowhere to go.
    const targetNode = found.field ? found.field.node : found.node;
    const targets = found.field ? [found.field.widget] : (targetNode.widgets || []).filter(isSetting);
    const put = (widget, value) => {
        const holder = found.field ? found.field : holderOf({ node: targetNode, widget });
        setValue(holder.node, holder.widget, value, restored, label);
    };

    const used = new Set();
    const unmatchedText = [];
    for (const entry of savedEntries(saved)) {
        const widget = targets.find((item) => item.name === entry.name && !used.has(item));
        if (widget) {
            used.add(widget);
            put(widget, entry.value);
        } else if (entry.isText) {
            unmatchedText.push(entry);
        } else {
            problems.push(`${label}: it has no "${entry.name}" setting`);
        }
    }

    const freeTextFields = targets.filter((widget) => !used.has(widget) && isTextSetting(widget));
    unmatchedText.forEach((entry, index) => {
        if (index < freeTextFields.length) {
            put(freeTextFields[index], entry.value);
        }
    });
    const left = unmatchedText.slice(freeTextFields.length).map((entry) => `"${entry.name}"`);
    if (left.length > 0) {
        problems.push(`${label}: there was nowhere to put the saved text from ${left.join(", ")}`);
    }

    // The rest only applies when a whole node was saved and the slot still leads to a whole node.
    if (found.field || "field" in saved) {
        return;
    }
    const node = targetNode;
    if (typeof saved.mode === "number") {
        node.mode = saved.mode;
    }
    if (restore.title && typeof saved.title === "string") {
        node.title = saved.title;
    }
    if (restore.color && "color" in saved) {
        node.color = saved.color ?? undefined;
        node.bgcolor = saved.bgcolor ?? undefined;
    }
    if (restore.size && Array.isArray(saved.size)) {
        if (typeof node.setSize === "function") {
            node.setSize([saved.size[0], saved.size[1]]);
        } else {
            node.size = [saved.size[0], saved.size[1]];
        }
    }
    if (restore.collapsed && typeof saved.collapsed === "boolean" && !!node.flags?.collapsed !== saved.collapsed) {
        node.collapse?.(true);
    }
}

async function settle(node, token, restored, problems, interrupted) {
    // Keeps checking the restored settings for a moment, since some nodes change their own settings, or load a
    // dropdown's choices, after a setting changes. A setting that no longer matches is set again once its value
    // can be used. If a dropdown's value still isn't among its choices after a while, every setting is set again,
    // so the node reloads its choices for the restored settings. Once everything matches, and anything had to be
    // set again, the node is told about every setting once more, in order, so whatever it shows (like an image
    // preview) ends up matching. After everything matches, it keeps watching for a second in case the node
    // changes something late, such as when a dropdown's choices from an earlier setting arrive after the newer
    // ones, then stops. Returns false if another profile was picked in the meantime, which takes over.
    // "interrupted" means this load took over from one still in progress. That one may have left the node
    // still reacting, like an image preview still loading, so the node is told about every setting once
    // more after everything matches, the same as when something had to be set again.
    const started = Date.now();
    let settledChecks = 0;
    let matchedSince = null;
    let fixed = !!interrupted;
    let retried = false;
    let toldAgain = 0;
    const tellAll = (why) => {
        debug(`${why} (after ${Date.now() - started} ms)`);
        for (const item of restored) {
            item.waiting = !available(item.node, item.widget, item.value);
            if (item.waiting) {
                item.widget.value = copyOf(item.value);
            } else {
                setAndTell(item.node, item.widget, item.value, item.label);
            }
        }
    };
    while (true) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_STEP_MS));
        if (node._loadToken !== token) {
            debug(`Stopped checking: another profile was picked`);
            return false;
        }
        let allMatch = true;
        let stillWaiting = false;
        for (const item of restored) {
            if (!item.waiting && sameValue(item.widget.value, item.value)) {
                continue;
            }
            allMatch = false;
            if (!available(item.node, item.widget, item.value)) {
                stillWaiting = true;
                continue;
            }
            if (!item.waiting) {
                debug(`${item.label}: the node changed "${item.widget.name}", setting it back`);
            }
            item.waiting = false;
            fixed = true;
            setAndTell(item.node, item.widget, item.value, item.label);
            debug(`${item.label}: "${item.widget.name}" restored (after ${Date.now() - started} ms)`);
        }
        if (stillWaiting && !retried && Date.now() - started >= SETTLE_RETRY_MS) {
            retried = true;
            fixed = true;
            settledChecks = 0;
            matchedSince = null;
            tellAll("A dropdown's value still isn't among its choices, so every setting is set again");
            continue;
        }
        settledChecks = allMatch ? settledChecks + 1 : 0;
        if (settledChecks >= SETTLED_CHECKS && fixed && toldAgain < MAX_TELL_AGAIN) {
            toldAgain += 1;
            fixed = false;
            settledChecks = 0;
            tellAll("Settings had to be set again, so the node is told about all of them once more");
            // The second of watching counts from here, as long as everything still matches at the next check.
            matchedSince = Date.now();
            continue;
        }
        if (!allMatch) {
            matchedSince = null;
        } else if (matchedSince === null) {
            matchedSince = Date.now();
        } else if (Date.now() - matchedSince >= WATCH_AFTER_MATCH_MS) {
            debug(`All settings matched, stopped checking after ${Date.now() - started} ms`);
            return true;
        }
        if (Date.now() - started >= SETTLE_TIME_MS) {
            break;
        }
    }
    for (const item of restored) {
        if (item.waiting || !available(item.node, item.widget, item.value)) {
            if (item.waiting && sameValue(item.widget.value, item.value)) {
                // Never became one of the choices, so the dropdown goes back to what it showed before.
                item.widget.value = item.previous;
            }
            problems.push(`${item.label}: "${item.value}" is no longer available for "${item.widget.name}"`);
        } else if (!sameValue(item.widget.value, item.value)) {
            problems.push(`${item.label}: the node keeps changing "${item.widget.name}" to "${item.widget.value}"`);
        }
    }
    debug(`Stopped checking after ${Date.now() - started} ms`);
    return true;
}

// ---------------------------------------------------------------------------------------------------------
// Popups and messages

function messageDialog(message) {
    // A small popup with an OK button, for warnings that list several things to read at your own pace.
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        Object.assign(overlay.style, {
            position: "fixed",
            inset: "0",
            background: "rgba(0, 0, 0, 0.5)",
            zIndex: "10000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
        });

        const box = document.createElement("div");
        Object.assign(box.style, {
            background: "var(--comfy-menu-bg, #353535)",
            color: "var(--fg-color, #ffffff)",
            border: "1px solid var(--border-color, #4e4e4e)",
            borderRadius: "8px",
            padding: "16px",
            minWidth: "320px",
            maxWidth: "560px",
            fontFamily: "sans-serif",
            fontSize: "14px",
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
        });

        const heading = document.createElement("div");
        heading.textContent = NODE_TITLE;
        Object.assign(heading.style, { fontWeight: "bold", fontSize: "16px", marginBottom: "10px" });
        box.appendChild(heading);

        const text = document.createElement("div");
        text.textContent = message;
        Object.assign(text.style, { whiteSpace: "pre-wrap", marginBottom: "12px", maxHeight: "50vh", overflowY: "auto" });
        box.appendChild(text);

        const buttons = document.createElement("div");
        Object.assign(buttons.style, { display: "flex", justifyContent: "flex-end" });
        const okButton = document.createElement("button");
        okButton.textContent = "OK";
        Object.assign(okButton.style, {
            padding: "6px 16px",
            background: "var(--comfy-input-bg, #222222)",
            color: "var(--fg-color, #ffffff)",
            border: "1px solid var(--border-color, #4e4e4e)",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "14px",
        });
        okButton.addEventListener("click", () => {
            overlay.remove();
            resolve();
        });
        buttons.appendChild(okButton);
        box.appendChild(buttons);

        overlay.appendChild(box);
        document.body.appendChild(overlay);
        okButton.focus();
    });
}

async function confirmDialog(message, type) {
    // ComfyUI's own confirm popup. "type" picks its buttons, such as "overwrite" or "delete".
    const dialog = app.extensionManager?.dialog;
    if (typeof dialog?.confirm === "function") {
        return (await dialog.confirm({ title: NODE_TITLE, message, type })) === true;
    }
    return window.confirm(message);
}

async function nameDialog(message, startingName) {
    // ComfyUI's own popup for typing a name. Returns the name, or null if cancelled.
    const dialog = app.extensionManager?.dialog;
    const result =
        typeof dialog?.prompt === "function"
            ? await dialog.prompt({ title: NODE_TITLE, message, defaultValue: startingName })
            : window.prompt(message, startingName);
    return result === null || result === undefined ? null : String(result).trim();
}

function warn(message) {
    // Only shown in the pop-up, not written to the browser console, since it can include settings' values.
    return messageDialog(message);
}

function done(message) {
    console.log(`${LOG_PREFIX} ${message}`);
    const toast = app.extensionManager?.toast;
    if (typeof toast?.add === "function") {
        toast.add({ severity: "success", summary: NODE_TITLE, detail: message, life: 3000 });
    }
}

// ---------------------------------------------------------------------------------------------------------
// Profiles

function markChanged() {
    // Shows the workflow as having unsaved changes, and makes the change undoable.
    app.graph?.setDirtyCanvas?.(true, true);
    const tracker = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
    try {
        if (typeof tracker?.captureCanvasState === "function") {
            tracker.captureCanvasState();
        } else if (typeof tracker?.checkState === "function") {
            tracker.checkState();
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Couldn't record the change:`, error);
    }
}

function profilesOf(node) {
    node.properties = node.properties || {};
    const profiles = node.properties.profiles;
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
        node.properties.profiles = {};
    }
    return node.properties.profiles;
}

function hasProfile(profiles, name) {
    // Only profiles actually saved count, not the names every JavaScript object has built in, like
    // "toString" or "constructor".
    return typeof name === "string" && Object.hasOwn(profiles, name);
}

function setProfile(profiles, name, profile) {
    // Stores the profile as a plain entry, so any name works, including special ones like "__proto__".
    Object.defineProperty(profiles, name, { value: profile, enumerable: true, writable: true, configurable: true });
}

function profileNames(node) {
    return Object.keys(profilesOf(node)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function findWidget(node, name) {
    return (node.widgets || []).find((widget) => widget.name === name) || null;
}

function refreshProfileList(node, select) {
    const list = findWidget(node, "profile");
    if (!list) {
        return;
    }
    const names = profileNames(node);
    list.options = list.options || {};
    list.options.values = names.length > 0 ? names : [NO_PROFILE];
    if (select !== undefined) {
        list.value = select;
    }
    if (!list.options.values.includes(list.value)) {
        list.value = list.options.values[0];
    }
    // Selections made here, after Save As, Rename, Delete or Import, don't load anything.
    node._pickedProfile = list.value;
    node.setDirtyCanvas?.(true, true);
}

async function profilePicked(node, value) {
    // Loads a profile when a different one is picked from the list. Picking the one already selected does nothing.
    const previous = node._pickedProfile;
    if (value === previous) {
        return;
    }
    // While a profile is still being loaded, its settings may not all match yet, so that's not asked about.
    if (!node._loading && previous && hasProfile(profilesOf(node), previous) && saveWouldChange(node, previous) === true) {
        // The profile being left has changes that haven't been saved (Save is green), so ask first.
        const message = `Profile "${previous}" has changes that haven't been saved. Switch to "${value}" anyway?`;
        if (!(await confirmDialog(message, "default"))) {
            const list = findWidget(node, "profile");
            if (list) {
                list.value = previous;
            }
            node.setDirtyCanvas?.(true, true);
            return;
        }
    }
    node._pickedProfile = value;
    if (value && value !== NO_PROFILE && hasProfile(profilesOf(node), value)) {
        await loadProfile(node);
    }
}

function selectedProfile(node) {
    const value = findWidget(node, "profile")?.value;
    if (!value || value === NO_PROFILE || !hasProfile(profilesOf(node), value)) {
        return null;
    }
    return value;
}

function slotLabel(input) {
    return input.label || input.name;
}

function captureProfile(node) {
    const slots = {};
    const problems = [];
    for (const input of node.inputs || []) {
        if (input.link == null) {
            continue;
        }
        const found = sourceOf(node.graph, input.link);
        if (found.error) {
            problems.push(`${slotLabel(input)}: ${found.error}`);
            continue;
        }
        slots[input.name] = found.field ? captureField(found.field) : captureNode(found.node);
    }
    return { slots, problems };
}

async function saveInto(node, name) {
    const { slots, problems } = captureProfile(node);
    if (Object.keys(slots).length === 0) {
        await warn("Nothing is connected to the slots, so there's nothing to save.");
        return false;
    }
    setProfile(profilesOf(node), name, { slots });
    refreshProfileList(node, name);
    markChanged();
    if (problems.length > 0) {
        await warn(`Saved "${name}", but these slots were left out:\n\n${problems.join("\n")}`);
    } else {
        done(`Saved "${name}"`);
    }
    return true;
}

async function loadProfile(node) {
    const name = selectedProfile(node);
    if (!name) {
        return;
    }
    const restore = {};
    for (const toggle of TOGGLES) {
        restore[toggle.key] = !!findWidget(node, toggle.name)?.value;
    }

    // Picking another profile while this one is still loading takes over, and this one stops.
    const token = (node._loadToken || 0) + 1;
    const interrupted = !!node._loading;
    const fast = !!findWidget(node, FAST_LOAD)?.value;
    node._loadToken = token;
    node._loading = true;
    setHasChanges(node, false);
    if (fast) {
        // No checking, so no bar. A bar left from a load still going when this one started sweeps away.
        finishProgress(node);
    } else {
        startProgress(node);
    }
    debug(`Loading "${name}"${fast ? " (fast load)" : ""}`);

    const problems = [];
    const restored = [];
    for (const [slotName, saved] of Object.entries(profilesOf(node)[name].slots || {})) {
        const input = (node.inputs || []).find((item) => item.name === slotName);
        if (!input) {
            problems.push(`${slotName}: this slot has been removed`);
            continue;
        }
        if (input.link == null) {
            problems.push(`${slotLabel(input)}: nothing is connected to it`);
            continue;
        }
        const found = sourceOf(node.graph, input.link);
        if (found.error) {
            problems.push(`${slotLabel(input)}: ${found.error}`);
            continue;
        }
        const title = (found.field ? found.field.node : found.node).title;
        restoreSlot(found, saved, restore, problems, restored, `${slotLabel(input)} (${title})`);
    }

    let finished = false;
    try {
        if (fast) {
            // Done at once: a dropdown value that isn't among its choices right now isn't waited for.
            for (const item of restored) {
                if (item.waiting) {
                    if (sameValue(item.widget.value, item.value)) {
                        item.widget.value = item.previous;
                    }
                    problems.push(`${item.label}: "${item.value}" is no longer available for "${item.widget.name}"`);
                }
            }
            finished = true;
        } else {
            finished = await settle(node, token, restored, problems, interrupted);
        }
    } finally {
        if (node._loadToken === token) {
            node._loading = false;
            finishProgress(node);
        }
    }
    if (!finished) {
        return;
    }
    checkForChanges(node);
    markChanged();
    if (problems.length > 0) {
        await warn(`Loaded "${name}", with these problems:\n\n${problems.join("\n")}`);
    } else {
        // No notice: profiles load every time one is picked, so notices would pile up while flipping through.
        console.log(`${LOG_PREFIX} Loaded "${name}"`);
    }
}

async function saveProfile(node) {
    const name = selectedProfile(node);
    if (!name) {
        // No profile to save over yet, so ask for a name, the same as Save As.
        await saveProfileAs(node);
        return;
    }
    if (await confirmDialog(`Overwrite profile "${name}"?`, "overwrite")) {
        await saveInto(node, name);
    }
}

async function saveProfileAs(node) {
    // Starts with the selected profile's name, so it's easy to save a variation under a similar name.
    const name = await nameDialog("Name for the new profile:", selectedProfile(node) ?? "");
    if (!name) {
        return;
    }
    if (name === NO_PROFILE) {
        await warn(`"${NO_PROFILE}" can't be used as a profile name.`);
        return;
    }
    if (hasProfile(profilesOf(node), name) && !(await confirmDialog(`Overwrite profile "${name}"?`, "overwrite"))) {
        return;
    }
    await saveInto(node, name);
}

async function renameProfile(node) {
    const oldName = selectedProfile(node);
    if (!oldName) {
        return;
    }
    const newName = await nameDialog(`New name for profile "${oldName}":`, oldName);
    if (!newName || newName === oldName) {
        return;
    }
    if (newName === NO_PROFILE) {
        await warn(`"${NO_PROFILE}" can't be used as a profile name.`);
        return;
    }
    const profiles = profilesOf(node);
    if (hasProfile(profiles, newName)) {
        await warn(`A profile named "${newName}" already exists. Delete it first to use that name.`);
        return;
    }
    setProfile(profiles, newName, profiles[oldName]);
    delete profiles[oldName];
    refreshProfileList(node, newName);
    markChanged();
    done(`Renamed "${oldName}" to "${newName}"`);
}

async function deleteProfile(node) {
    const name = selectedProfile(node);
    if (!name) {
        return;
    }
    if (!(await confirmDialog(`Delete profile "${name}"?`, "delete"))) {
        return;
    }
    delete profilesOf(node)[name];
    refreshProfileList(node, profileNames(node)[0] ?? NO_PROFILE);
    markChanged();
    done(`Deleted "${name}"`);
}

// ---------------------------------------------------------------------------------------------------------
// Export and import

// Marks a file as a Node Profiles export, and which format it uses.
const EXPORT_FORMAT = "node-profiles";
const EXPORT_VERSION = 1;

// The file name suggested when exporting. It can be changed in the save window. The file holds JSON, but has its
// own extension, so it isn't mistaken for a workflow (ComfyUI tries to open any .json file dropped on it as one),
// and browsers don't warn about it, as Chrome does for .cfg.
const EXPORT_EXTENSION = ".nodeprofiles";
const EXPORT_FILE_NAME = `profiles${EXPORT_EXTENSION}`;

async function exportProfiles(node) {
    const profiles = profilesOf(node);
    const count = Object.keys(profiles).length;
    if (count === 0) {
        await warn("There are no profiles to export.");
        return;
    }
    const text = JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, profiles }, null, 2);

    if (typeof window.showSaveFilePicker === "function") {
        // A save window to pick the location and file name. It asks on its own before replacing a file.
        let handle;
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: EXPORT_FILE_NAME,
                types: [{ description: "Node Profiles", accept: { "text/plain": [EXPORT_EXTENSION] } }],
            });
        } catch (error) {
            if (error?.name !== "AbortError") {
                await warn(`Couldn't open the save window: ${error?.message || error}`);
            }
            return;
        }
        try {
            const writable = await handle.createWritable();
            await writable.write(text);
            await writable.close();
        } catch (error) {
            await warn(`Couldn't save the file: ${error?.message || error}`);
            return;
        }
        done(`Exported ${count} profile(s) to ${handle.name}`);
        return;
    }

    // Browsers without a save window: a normal download.
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = EXPORT_FILE_NAME;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    done(`Exported ${count} profile(s)`);
}

function chooseFile() {
    // Opens a window to pick an exported file. Resolves to { name, text }, or null if nothing was picked.
    return new Promise((resolve) => {
        const picker = document.createElement("input");
        picker.type = "file";
        picker.accept = EXPORT_EXTENSION;
        picker.style.display = "none";
        picker.addEventListener("change", () => {
            const file = picker.files?.[0];
            picker.remove();
            if (!file) {
                resolve(null);
                return;
            }
            file.text().then((text) => resolve({ name: file.name, text }), () => resolve(null));
        });
        picker.addEventListener("cancel", () => {
            picker.remove();
            resolve(null);
        });
        document.body.appendChild(picker);
        picker.click();
    });
}

async function importProfiles(node) {
    const file = await chooseFile();
    if (!file) {
        return;
    }
    let imported;
    try {
        const data = JSON.parse(file.text);
        imported = data?.format === EXPORT_FORMAT ? data.profiles : null;
    } catch {
        imported = null;
    }
    if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
        await warn(`"${file.name}" isn't a Node Profiles export.`);
        return;
    }

    const replacement = {};
    for (const [name, profile] of Object.entries(imported)) {
        if (name && name !== NO_PROFILE && profile && typeof profile === "object") {
            setProfile(replacement, name, copyOf(profile));
        }
    }
    const newCount = Object.keys(replacement).length;
    const oldCount = Object.keys(profilesOf(node)).length;
    const question =
        `Replace all ${oldCount} profile(s) in this node with the ${newCount} profile(s) in "${file.name}"?`;
    if (!(await confirmDialog(question, "overwrite"))) {
        return;
    }
    node.properties.profiles = replacement;
    refreshProfileList(node, profileNames(node)[0] ?? NO_PROFILE);
    markChanged();
    done(`Imported ${newCount} profile(s) from ${file.name}`);
}

// ---------------------------------------------------------------------------------------------------------
// Slots

function nextSlotName(node) {
    // One past the highest slot number, so two slots can never share a name.
    let highest = 0;
    for (const input of node.inputs || []) {
        const number = Number(String(input.name).slice(SLOT_PREFIX.length));
        if (String(input.name).startsWith(SLOT_PREFIX) && Number.isInteger(number)) {
            highest = Math.max(highest, number);
        }
    }
    return `${SLOT_PREFIX}${highest + 1}`;
}

function addSlot(node) {
    // "removable" lets the slot be removed with Remove Slot in its right-click menu.
    node.addInput(nextSlotName(node), "*", { removable: true });
}

function updateSlots(node) {
    node.inputs = node.inputs || [];
    const last = () => node.inputs[node.inputs.length - 1];
    while (node.inputs.length < MIN_SLOTS) {
        addSlot(node);
    }
    if (last().link != null) {
        addSlot(node);
    }
    // Slots are never removed automatically. Disconnecting a wire leaves its slot in place;
    // slots are only removed with Remove Slot in their right-click menu.
    // Slots from a saved workflow may not remember that they can be removed.
    for (const input of node.inputs) {
        input.removable = true;
    }
    const needed = node.computeSize?.();
    if (needed) {
        node.setSize([Math.max(node.size[0], needed[0]), Math.max(node.size[1], needed[1])]);
    }
    node.setDirtyCanvas?.(true, true);
}

// ---------------------------------------------------------------------------------------------------------
// The node

// Height of the blank gaps between groups of buttons.
const GAP_HEIGHT = 10;
const SMALL_GAP_HEIGHT = 2;

// How often, in milliseconds, the node checks whether the connected nodes still match the selected profile.
const CHECK_INTERVAL_MS = 500;

// Save button color while the connected nodes differ from the selected profile.
const CHANGED_COLOR = "#2e7d32";
const CHANGED_TEXT_COLOR = "#ffffff";

function comparable(saved, restore) {
    // A saved slot without the parts that don't describe the node itself, and without the title, color, size
    // and collapsed state while their restore toggles are off, since Discard wouldn't put those back.
    if (!saved || typeof saved !== "object") {
        return saved;
    }
    const { choices, ...rest } = saved;
    if (!restore.title) {
        delete rest.title;
    }
    if (!restore.color) {
        delete rest.color;
        delete rest.bgcolor;
    }
    if (!restore.size) {
        delete rest.size;
    }
    if (!restore.collapsed) {
        delete rest.collapsed;
    }
    return JSON.stringify(rest);
}

function restoreToggles(node) {
    const restore = {};
    for (const toggle of TOGGLES) {
        restore[toggle.key] = !!findWidget(node, toggle.name)?.value;
    }
    return restore;
}

function saveWouldChange(node, name) {
    // True when clicking Save with this profile selected would change what's saved in it. Null when Save
    // wouldn't save anything, because nothing usable is connected.
    const savedSlots = profilesOf(node)[name]?.slots || {};
    const { slots } = captureProfile(node);
    const currentNames = Object.keys(slots);
    if (currentNames.length === 0) {
        return null;
    }
    const savedNames = Object.keys(savedSlots);
    if (savedNames.length !== currentNames.length || savedNames.some((slot) => !(slot in slots))) {
        return true;
    }
    const restore = restoreToggles(node);
    return currentNames.some((slot) => comparable(slots[slot], restore) !== comparable(savedSlots[slot], restore));
}

function differsFromProfile(node) {
    // True (Save turns green) whenever a profile is selected and clicking Save would change what's saved in it.
    // Picking a profile loads it, so the selected profile is always the one being worked from.
    const name = selectedProfile(node);
    return !!name && saveWouldChange(node, name) === true;
}

// Text color for the Discard button while it's grayed out, because there are no changes to discard.
const GRAYED_TEXT_COLOR = "#777777";

function recolorButton(button, colorsNow) {
    // ComfyUI's buttons have no color setting, so the colors they read while drawing are swapped just for
    // that moment. The button keeps ComfyUI's own look and click behavior. colorsNow() returns
    // { background, text } (either may be left out) for the colors to use right now, or null for normal.
    const LiteGraph = window.LiteGraph || {};
    const kinds = [
        { property: "background_color", global: "WIDGET_BGCOLOR", key: "background" },
        { property: "text_color", global: "WIDGET_TEXT_COLOR", key: "text" },
    ];

    for (const kind of kinds) {
        try {
            const original = Object.getOwnPropertyDescriptor(button, kind.property);
            let prototypeGetter = null;
            for (let proto = Object.getPrototypeOf(button); proto && !prototypeGetter; proto = Object.getPrototypeOf(proto)) {
                prototypeGetter = Object.getOwnPropertyDescriptor(proto, kind.property)?.get || null;
            }
            Object.defineProperty(button, kind.property, {
                configurable: true,
                get() {
                    const color = colorsNow()?.[kind.key];
                    if (color) {
                        return color;
                    }
                    if (original && "value" in original) {
                        return original.value;
                    }
                    return prototypeGetter ? prototypeGetter.call(this) : LiteGraph[kind.global];
                },
                set(value) {
                    Object.defineProperty(this, kind.property, { configurable: true, writable: true, value });
                },
            });
        } catch {
            // Some versions don't allow this; the drawing swap below still applies.
        }
    }

    for (const method of ["drawWidget", "draw"]) {
        const original = button[method];
        if (typeof original !== "function") {
            continue;
        }
        button[method] = function (...args) {
            const colors = colorsNow();
            if (!colors) {
                return original.apply(this, args);
            }
            const saved = {};
            for (const kind of kinds) {
                if (colors[kind.key]) {
                    saved[kind.global] = LiteGraph[kind.global];
                    LiteGraph[kind.global] = colors[kind.key];
                }
            }
            try {
                return original.apply(this, args);
            } finally {
                Object.assign(LiteGraph, saved);
            }
        };
    }
}

function addSaveButton(node) {
    // Green while the selected profile has changes that could be saved.
    const button = node.addWidget("button", "Save", null, () => saveProfile(node));
    recolorButton(button, () => (node._hasChanges ? { background: CHANGED_COLOR, text: CHANGED_TEXT_COLOR } : null));
    return button;
}

function addDiscardButton(node) {
    // Discards changes by putting the selected profile's saved settings back. Grayed out, and does nothing,
    // while there are no changes to discard.
    const button = node.addWidget("button", "Discard", null, () => {
        if (node._hasChanges) {
            loadProfile(node);
        }
    });
    recolorButton(button, () => (node._hasChanges ? null : { text: GRAYED_TEXT_COLOR }));
    button.disabled = true;
    return button;
}

function startChecking(node) {
    // Checks a couple of times a second, and redraws only when the result changes. Stops once the node
    // is no longer in a workflow.
    stopChecking(node);
    node._profileCheck = setInterval(() => {
        if (!node.graph || findNode(node.graph, node.id) !== node) {
            stopChecking(node);
            return;
        }
        checkForChanges(node);
    }, CHECK_INTERVAL_MS);
}

// Color of the bar that fills the profile list while a profile is loading.
const PROGRESS_COLOR = "#1976d2";

// When loading finishes, how long the bar takes to sweep the rest of the way across, in milliseconds.
const PROGRESS_SWEEP_MS = 200;

function startProgress(node) {
    // Starts the bar over from the left, also when another profile is picked while one is still loading.
    node._progress = { started: Date.now(), finishedAt: null, from: 0 };
    animateProgress(node);
}

function finishProgress(node) {
    const progress = node._progress;
    if (!progress || progress.finishedAt !== null) {
        return;
    }
    progress.from = progressOf(node) ?? 0;
    progress.finishedAt = Date.now();
}

function progressOf(node) {
    // How much of the list is filled, from 0 to 1, or null when nothing is loading. While loading, it fills
    // toward the longest a load can take. Once done, it sweeps the rest of the way across.
    const progress = node._progress;
    if (!progress) {
        return null;
    }
    const now = Date.now();
    if (progress.finishedAt === null) {
        return Math.min(1, (now - progress.started) / SETTLE_TIME_MS);
    }
    const sweep = Math.min(1, (now - progress.finishedAt) / PROGRESS_SWEEP_MS);
    return progress.from + (1 - progress.from) * sweep;
}

function animateProgress(node) {
    // Redraws the node every frame while the bar is showing, then once more after it's gone.
    if (node._progressAnimating) {
        return;
    }
    node._progressAnimating = true;
    const step = () => {
        const progress = node._progress;
        if (progress && progress.finishedAt !== null && Date.now() - progress.finishedAt >= PROGRESS_SWEEP_MS) {
            node._progress = null;
        }
        node.setDirtyCanvas?.(true, false);
        if (!node._progress) {
            node._progressAnimating = false;
            return;
        }
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

function addProgressFill(list, node) {
    // Draws the bar inside the profile list, over its background and under its text. ComfyUI draws a list's
    // background and outline first, then its text, so the bar is drawn right after the background, and the
    // outline is drawn again on top of it.
    const drawShape = list?.drawWidgetShape;
    if (typeof drawShape !== "function") {
        return;
    }
    list.drawWidgetShape = function (ctx, options) {
        drawShape.call(this, ctx, options);
        const fraction = progressOf(node);
        if (fraction === null || !options?.showText) {
            return;
        }
        const margin = this.constructor?.margin ?? 15;
        const width = options.width - margin * 2;
        const { height, y } = this;
        const outline = () => {
            ctx.beginPath();
            ctx.roundRect(margin, y, width, height, [height * 0.5]);
        };
        ctx.save();
        outline();
        ctx.clip();
        ctx.fillStyle = PROGRESS_COLOR;
        ctx.fillRect(margin, y, width * fraction, height);
        ctx.restore();
        if (!this.computedDisabled) {
            outline();
            ctx.stroke();
        }
    };
}

function checkForChanges(node) {
    // Turns Save green, and Discard on, when the settings differ from the selected profile.
    if (node._loading) {
        // Settings may not all match until the profile has finished loading.
        return;
    }
    let changed = false;
    try {
        changed = differsFromProfile(node);
    } catch (error) {
        changed = false;
    }
    setHasChanges(node, changed);
}

function setHasChanges(node, changed) {
    // Redraws only when the result changes.
    if (changed === !!node._hasChanges) {
        return;
    }
    node._hasChanges = changed;
    const discard = findWidget(node, "Discard");
    if (discard) {
        discard.disabled = !changed;
    }
    node.setDirtyCanvas?.(true, true);
}

function stopChecking(node) {
    if (node._profileCheck) {
        clearInterval(node._profileCheck);
        node._profileCheck = null;
    }
}

function addGap(node, name, height = GAP_HEIGHT) {
    // An empty widget that only takes up space.
    const gap = {
        type: "gap",
        name,
        value: null,
        draw() {},
        computeSize(width) {
            return [width, height];
        },
    };
    if (typeof node.addCustomWidget === "function") {
        node.addCustomWidget(gap);
    } else {
        node.widgets = node.widgets || [];
        node.widgets.push(gap);
    }
}

app.registerExtension({
    name: "BRB.NodeProfiles",
    registerCustomNodes() {
        const LiteGraph = window.LiteGraph;
        const LGraphNode = window.LGraphNode;
        if (!LiteGraph || !LGraphNode) {
            console.error(`${LOG_PREFIX} Not active: this version of ComfyUI doesn't provide what the node needs`);
            return;
        }

        class NodeProfilesNode extends LGraphNode {
            constructor(title) {
                super(title ?? NODE_TITLE);
                // Only used in the page: it's left out of the job sent to the server, so it never runs.
                this.isVirtualNode = true;
                // The selected profile and the toggles are saved by name in the node's properties (see
                // onSerialize), not as a list of field values, so changes to the node's layout can never mix them up.
                this.serialize_widgets = false;
                this.properties = this.properties || {};
                profilesOf(this);

                addGap(this, "gap_top", SMALL_GAP_HEIGHT);
                // Picking a different profile in the list loads it.
                const list = this.addWidget("combo", "profile", NO_PROFILE, (value) => profilePicked(this, value), {
                    values: [NO_PROFILE],
                });
                addProgressFill(list, this);
                addGap(this, "gap_profile", SMALL_GAP_HEIGHT);
                addSaveButton(this);
                addGap(this, "gap_save", SMALL_GAP_HEIGHT);
                addDiscardButton(this);
                addGap(this, "gap_reload");
                this.addWidget("button", "Save As", null, () => saveProfileAs(this));
                addGap(this, "gap_save_as", SMALL_GAP_HEIGHT);
                this.addWidget("button", "Rename", null, () => renameProfile(this));
                addGap(this, "gap_rename");
                this.addWidget("button", "Delete", null, () => deleteProfile(this));
                addGap(this, "gap_3");
                const fastLoad = this.addWidget("toggle", FAST_LOAD, true, () => {}, {
                    on: "on",
                    off: "off",
                    tooltip: FAST_LOAD_TOOLTIP,
                });
                fastLoad.tooltip = FAST_LOAD_TOOLTIP;
                addGap(this, "gap_fast_load", SMALL_GAP_HEIGHT);
                TOGGLES.forEach((toggle, index) => {
                    if (index > 0) {
                        addGap(this, `gap_${toggle.key}`, SMALL_GAP_HEIGHT);
                    }
                    this.addWidget("toggle", toggle.name, false, () => {}, { on: "on", off: "off" });
                });
                addGap(this, "gap_toggles");
                this.addWidget("button", "Import", null, () => importProfiles(this));
                addGap(this, "gap_import", SMALL_GAP_HEIGHT);
                this.addWidget("button", "Export", null, () => exportProfiles(this));

                for (let index = 1; index <= MIN_SLOTS; index++) {
                    addSlot(this);
                }
                const size = this.computeSize();
                this.setSize([Math.round(size[0] * START_WIDTH_FACTOR), size[1]]);
            }

            onConnectionsChange(type) {
                if (type !== LiteGraph.INPUT || app.configuringGraph) {
                    return;
                }
                setTimeout(() => updateSlots(this), 0);
            }

            onInputRemoved() {
                if (app.configuringGraph) {
                    return;
                }
                setTimeout(() => updateSlots(this), 0);
            }

            onSerialize(data) {
                data.properties = data.properties || {};
                data.properties.selected = findWidget(this, "profile")?.value ?? null;
                const restore = {};
                for (const toggle of TOGGLES) {
                    restore[toggle.key] = !!findWidget(this, toggle.name)?.value;
                }
                data.properties.restore = restore;
                data.properties.fast_load = !!findWidget(this, FAST_LOAD)?.value;
            }

            onAdded() {
                startChecking(this);
            }

            onRemoved() {
                stopChecking(this);
            }

            onConfigure() {
                const saved = this.properties || {};
                for (const toggle of TOGGLES) {
                    const widget = findWidget(this, toggle.name);
                    if (widget && typeof saved.restore?.[toggle.key] === "boolean") {
                        widget.value = saved.restore[toggle.key];
                    }
                }
                // Workflows saved before this toggle existed don't have it, so it's on for those, its default. That
                // also undoes a value ComfyUI may have put in it from the old order of the node's widgets.
                const fastLoad = findWidget(this, FAST_LOAD);
                if (fastLoad) {
                    fastLoad.value = saved.fast_load !== false;
                }
                setTimeout(() => {
                    updateSlots(this);
                    refreshProfileList(this, typeof saved.selected === "string" ? saved.selected : undefined);
                }, 0);
            }

        }

        NodeProfilesNode.title = NODE_TITLE;
        NodeProfilesNode.category = "utils";
        LiteGraph.registerNodeType(NODE_TYPE, NodeProfilesNode);
        console.log(`${LOG_PREFIX} Loaded`);
    },
});
