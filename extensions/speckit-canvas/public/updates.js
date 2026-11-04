const status = document.getElementById("update-status");
const checkButton = document.getElementById("update-check");
const installButton = document.getElementById("update-install");
const dialog = document.getElementById("update-dialog");
const description = document.getElementById("update-description");
const confirmButton = document.getElementById("update-confirm");
const cancelButton = document.getElementById("update-cancel");
let latest = null;
let busy = false;
let confirmedVersion = null;

async function request(path, body) {
    const response = await fetch(path, body === undefined ? undefined : {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Speckit-Update": "1" },
        body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Update request failed (${response.status}).`);
    return data;
}

function render() {
    checkButton.disabled = busy;
    installButton.disabled = busy || latest?.updating;
    installButton.hidden = Boolean(!latest?.available || !latest.canUpdate || latest.restartRequired);
    if (!latest) return;
    if (latest.restartRequired) {
        status.textContent = `Installed v${latest.installedVersion}. Reload extensions or restart the app/session, then reopen the board.`;
    } else if (latest.updating) {
        status.textContent = "Plugin update in progress...";
    } else if (latest.available) {
        status.textContent = `v${latest.latestVersion} available (running v${latest.currentVersion}).${latest.canUpdate ? "" : " Development preview: update the managed plugin in Copilot."}`;
        installButton.textContent = `Update to v${latest.latestVersion}`;
    } else {
        status.textContent = `v${latest.currentVersion} - ${latest.latestVersion ? "up to date" : "no published releases"}.`;
    }
}

async function check(manual = false) {
    if (busy) return;
    busy = true;
    render();
    status.textContent = "Checking for updates...";
    try {
        latest = await request(manual ? "/api/updates/check" : "/api/updates", manual ? {} : undefined);
        render();
    } catch (error) {
        latest = null;
        status.textContent = `Could not check for updates: ${error.message}`;
        installButton.hidden = true;
    } finally {
        busy = false;
        checkButton.disabled = false;
        installButton.disabled = Boolean(latest?.updating);
    }
}

checkButton.addEventListener("click", () => void check(true));
installButton.addEventListener("click", () => {
    if (busy || !latest?.available || !latest.canUpdate) return;
    confirmedVersion = latest.latestVersion;
    description.textContent = `Install published Spec-kit Canvas release ${latest.releaseTag || `v${confirmedVersion}`} (running v${latest.currentVersion})? Only this release's tagged code will be installed, never the default branch. Copilot will install it as a release-pinned direct plugin; an existing marketplace copy will be disabled to prevent duplicates. Reload extensions or restart the app/session afterward. Your specs and constitution are not changed.`;
    dialog.showModal();
});
cancelButton.addEventListener("click", () => dialog.close());
confirmButton.addEventListener("click", async () => {
    if (busy || !dialog.open) return;
    dialog.close();
    busy = true;
    render();
    status.textContent = "Updating plugin...";
    try {
        latest = await request("/api/updates/install", { confirmed: true, version: confirmedVersion });
        render();
    } catch (error) {
        status.textContent = `Update failed: ${error.message}`;
    } finally {
        busy = false;
        checkButton.disabled = false;
        installButton.disabled = false;
    }
});

void check();
const timer = setInterval(() => void check(), 60 * 60 * 1000);
addEventListener("pagehide", () => clearInterval(timer), { once: true });
