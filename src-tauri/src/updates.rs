//! Signed releases are downloaded quietly and installed only when the user quits.
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, MenuItem},
    AppHandle, Manager, Wry,
};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const RELEASES: &str = "https://github.com/HyperCactus/knightlight/releases/latest";
struct Pending {
    manual: bool,
    update: Update,
    path: PathBuf,
}
pub struct Updates {
    profile: PathBuf,
    enabled: AtomicBool,
    busy: AtomicBool,
    installing: AtomicBool,
    pending: Mutex<Option<Pending>>,
    status: MenuItem<Wry>,
    automatic: CheckMenuItem<Wry>,
}
impl Updates {
    pub fn new(profile: PathBuf, status: MenuItem<Wry>, automatic: CheckMenuItem<Wry>) -> Self {
        let enabled = std::fs::read_to_string(profile.join("automatic-updates"))
            .map(|s| s.trim() != "off")
            .unwrap_or(true);
        let _ = automatic.set_checked(enabled);
        Self {
            profile,
            enabled: AtomicBool::new(enabled),
            busy: AtomicBool::new(false),
            installing: AtomicBool::new(false),
            pending: Mutex::new(None),
            status,
            automatic,
        }
    }
    fn status(&self, text: &str) {
        let _ = self.status.set_text(text);
    }
    fn log(&self, text: &str) {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.profile.join("desktop-updates.log"))
        {
            let _ = writeln!(file, "{text}");
        }
    }
    pub fn toggle(&self) {
        let enabled = !self.enabled.load(Ordering::SeqCst);
        // Commit to disk before changing runtime policy.
        if std::fs::write(
            self.profile.join("automatic-updates"),
            if enabled { "on" } else { "off" },
        )
        .is_ok()
        {
            self.enabled.store(enabled, Ordering::SeqCst);
            let _ = self.automatic.set_checked(enabled);
            self.status(if enabled {
                "Automatic updates enabled"
            } else {
                "Automatic updates off — check manually"
            });
        } else {
            self.status("Could not save update preference");
        }
    }
}
fn supports_install() -> bool {
    !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some()
}
fn notify(app: &AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(message) = serde_json::to_string(message) {
            let _ = window.eval(format!("if(typeof toast==='function')toast({message})"));
        }
    }
}
pub fn start(app: AppHandle) {
    if cfg!(debug_assertions) || std::env::var_os("KNIGHTLIGHT_DESKTOP_SMOKE").is_some() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            if app.state::<Updates>().enabled.load(Ordering::SeqCst) {
                check(app.clone(), false);
            }
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}
pub fn check(app: AppHandle, manual: bool) {
    if std::env::var_os("KNIGHTLIGHT_DESKTOP_SMOKE").is_some() {
        return;
    }
    let state = app.state::<Updates>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Updates>();
        state.status("Checking for updates…");
        let result = async {
            let updater = app
                .updater_builder()
                .timeout(Duration::from_secs(30))
                .build()?;
            if let Some(mut update) = updater.check().await? {
                if !supports_install() {
                    state.status("Update available — download from Releases");
                    if manual {
                        let _ = open::that(RELEASES);
                    }
                    return Ok::<(), Box<dyn std::error::Error + Send + Sync>>(());
                }
                if update.download_url.scheme() != "https"
                    || update.download_url.host_str() != Some("github.com")
                    || !update
                        .download_url
                        .path()
                        .starts_with("/HyperCactus/knightlight/releases/download/")
                {
                    return Err("Unexpected update download origin".into());
                }
                state.status("Downloading update in background…");
                update.timeout = Some(Duration::from_secs(20 * 60));
                let path = state.profile.join("ready-update.bin");
                let cached = std::fs::read(&path)
                    .ok()
                    .filter(|bytes| update.verify(bytes).is_ok());
                let bytes = match cached {
                    Some(bytes) => bytes,
                    None => update.download(|_, _| {}, || {}).await?,
                };
                // The plugin verifies the signature before returning any download.
                let temp = state.profile.join("ready-update.tmp");
                std::fs::write(&temp, bytes)?;
                // Windows rename does not replace an existing file.
                if path.exists() {
                    std::fs::remove_file(&path)?;
                }
                std::fs::rename(temp, &path)?;
                state.log(&format!("Verified update {}", update.version));
                *state.pending.lock().unwrap() = Some(Pending {
                    manual,
                    update,
                    path,
                });
                state.status("Update ready — installs when you quit");
                if manual {
                    notify(
                        &app,
                        "Update ready. It will install when you quit Knightlight.",
                    );
                }
            } else {
                state.status("Knightlight is up to date");
                if manual {
                    notify(&app, "You have the latest Knightlight release.");
                }
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            state.status("Update check failed — try again later");
            state.log(&format!("Update error: {error}"));
            if manual {
                notify(
                    &app,
                    "Could not check for updates. Your current app is still available.",
                );
            }
        }
        state.busy.store(false, Ordering::SeqCst);
    });
}
/// Returns true only when an intentional, successful quit should wait for installation.
pub fn install_on_exit(app: &AppHandle) -> bool {
    let state = app.state::<Updates>();
    if state.installing.load(Ordering::SeqCst) {
        return false;
    }
    let Some(pending) = state.pending.lock().unwrap().take() else {
        return false;
    };
    if !state.enabled.load(Ordering::SeqCst) && !pending.manual {
        *state.pending.lock().unwrap() = Some(pending);
        return false;
    }
    state.installing.store(true, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Updates>();
        let result = std::fs::read(&pending.path)
            .map_err(|e| e.to_string())
            .and_then(|bytes| {
                // install() verifies again, including a cache altered after downloading.
                pending
                    .update
                    .restart_after_install(false)
                    .install(bytes)
                    .map_err(|e| e.to_string())
            });
        match result {
            Ok(()) => {
                let _ = std::fs::remove_file(pending.path);
                state.log("Update installed");
            }
            Err(error) => state.log(&format!("Installation failed: {error}")),
        }
        app.exit(0);
    });
    true
}

#[cfg(test)]
mod tests {
    use tauri_plugin_updater::UpdaterExt;
    const PAYLOAD: &[u8] = include_bytes!("../../tests/fixtures/updater/payload");
    fn updater() -> tauri_plugin_updater::Updater {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": include_str!("../../tests/fixtures/updater/test-public-key").trim(),
                "requireSignedVersion": true
            }),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        app.updater_builder()
            .target("test-target")
            .executable_path("/tmp/knightlight-test-app")
            .endpoints(vec!["https://example.invalid/latest.json".parse().unwrap()])
            .unwrap()
            .build()
            .unwrap()
    }
    fn metadata(version: &str) -> serde_json::Value {
        serde_json::json!({"version": version, "platforms": {"test-target": {
            "url": "https://example.invalid/update",
            "signature": include_str!("../../tests/fixtures/updater/payload.sig").trim()
        }}})
    }
    #[test]
    fn signed_update_verifies_and_tampering_is_rejected() {
        let update = updater()
            .restore_update(metadata("9.0.0"))
            .unwrap()
            .unwrap();
        update.verify(PAYLOAD).unwrap();
        assert!(update.verify(b"replaced payload").is_err());
        let mut changed = PAYLOAD.to_vec();
        changed[0] ^= 1;
        assert!(update.verify(&changed).is_err());
    }
    #[test]
    fn inflated_manifest_version_cannot_replay_an_older_signed_release() {
        let update = updater()
            .restore_update(metadata("99.0.0"))
            .unwrap()
            .unwrap();
        assert!(update.verify(PAYLOAD).is_err());
    }
    #[test]
    fn downgrade_and_current_release_are_ignored() {
        for version in ["0.0.1", "0.1.0"] {
            assert!(updater()
                .restore_update(metadata(version))
                .unwrap()
                .is_none());
        }
    }
    #[test]
    fn shipped_configuration_requires_https_signatures_and_no_frontend_ipc() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["plugins"]["updater"]["requireSignedVersion"], true);
        assert!(config["plugins"]["updater"]["endpoints"][0]
            .as_str()
            .unwrap()
            .starts_with("https://github.com/HyperCactus/knightlight/"));
        assert_eq!(
            config["app"]["security"]["capabilities"],
            serde_json::json!([])
        );
    }
}
