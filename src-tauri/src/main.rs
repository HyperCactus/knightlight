#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod updates;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::DownloadEvent,
    Manager, WebviewUrl, WebviewWindowBuilder,
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let smoke = std::env::var_os("KNIGHTLIGHT_DESKTOP_SMOKE").is_some();
            if smoke && std::env::var_os("KNIGHTLIGHT_PROFILE").is_none() {
                return Err("Smoke tests require an explicit disposable KNIGHTLIGHT_PROFILE".into());
            }
            // Set paths once, before starting any backend threads. Installed resources
            // never contain personal games or receive writes, even after an upgrade.
            let resources = app.path().resource_dir()?.join("resources");
            let profile = std::env::var_os("KNIGHTLIGHT_PROFILE")
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            if !resources.join("static/index.html").is_file() {
                return Err(
                    "Desktop resources missing. Run python3 scripts/build-desktop.py first.".into(),
                );
            }
            std::env::set_var("KNIGHTLIGHT_RESOURCES", resources);
            chess_study::runtime::prepare_profile(&profile)?;

            // Reserve an ephemeral loopback port; never attach to another process
            // or the separately running browser edition on port 3000.
            let port_file = profile.join("desktop-port");
            let port = std::fs::read_to_string(&port_file)
                .ok()
                .and_then(|s| s.trim().parse::<u16>().ok())
                .filter(|p| *p >= 1024)
                .unwrap_or(0);
            let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                .or_else(|_| std::net::TcpListener::bind("127.0.0.1:0"))?;
            listener.set_nonblocking(true)?;
            let address = listener.local_addr()?;
            std::fs::write(port_file, address.port().to_string())?;
            let url = format!("http://{address}");
            let handle = app.handle().clone();
            let error_log = profile.join("desktop-errors.log");
            tauri::async_runtime::spawn(async move {
                let task = tauri::async_runtime::spawn(async move {
                    let listener = tokio::net::TcpListener::from_std(listener)?;
                    chess_study::serve(listener).await
                });
                match task.await {
                    Ok(Ok(())) => {}
                    result => {
                        eprintln!("Knightlight backend stopped: {result:?}");
                        let _ = std::fs::write(error_log, format!("Knightlight backend stopped: {result:?}\n"));
                        handle.exit(1);
                    }
                }
            });

            let browser = MenuItem::with_id(app, "browser", "Open in browser", true, None::<&str>)?;
            let data = MenuItem::with_id(app, "data", "Open data folder", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "Quit Knightlight", true, Some("CmdOrCtrl+Q"))?;
            let check = MenuItem::with_id(app, "updates-check", "Check for updates", true, None::<&str>)?;
            let automatic = CheckMenuItem::with_id(app, "updates-auto", "Automatic updates", true, true, None::<&str>)?;
            let status = MenuItem::with_id(app, "updates-status", "Updates checked in background", false, None::<&str>)?;
            app.manage(updates::Updates::new(profile.clone(), status.clone(), automatic.clone()));
            let file = Submenu::with_items(app, "Knightlight", true, &[&browser, &data, &check, &automatic, &status, &quit])?;
            updates::start(app.handle().clone());
            let edit = Submenu::with_items(app, "Edit", true, &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ])?;
            app.set_menu(Menu::with_items(app, &[&file, &edit])?)?;
            let browser_url = url.clone();
            app.on_menu_event(move |app, event| match event.id().as_ref() {
                "browser" => {
                    let _ = open::that(&browser_url);
                }
                "data" => {
                    let _ = open::that(&profile);
                }
                "quit" => app.exit(0),
                "updates-check" => updates::check(app.clone(), true),
                "updates-auto" => app.state::<updates::Updates>().toggle(),
                _ => {}
            });

            let smoke_handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Knightlight")
                .inner_size(1360.0, 920.0)
                .min_inner_size(800.0, 600.0)
                .initialization_script(if smoke {
                    // Test-only: silence HTML audio before any app script runs,
                    // and keep Web Audio contexts suspended. No preference changes.
                    "window.__nativeErrors=[];addEventListener('error',e=>__nativeErrors.push(e.message));addEventListener('unhandledrejection',e=>__nativeErrors.push(String(e.reason)));HTMLMediaElement.prototype.play=async function(){this.muted=true};for(const n of ['AudioContext','webkitAudioContext'])if(window[n])window[n].prototype.resume=async function(){};"
                } else { "" })
                .on_page_load(move |window, payload| {
                    if smoke && payload.event() == tauri::webview::PageLoadEvent::Finished {
                        let _ = window.eval("setTimeout(async()=>{try{if(__nativeErrors.length)throw Error(__nativeErrors.join('; '));if(!document.querySelector('#puzzle-board'))throw Error('Board missing');const r=await fetch('/api/data');if(!r.ok)throw Error('Backend unavailable');const d=await r.json();if(d.games.length)throw Error('Test profile contains personal games');location.href='knightlight-smoke://passed'}catch(e){location.href='knightlight-smoke://failed/'+encodeURIComponent(e.message)}},2500)");
                    }
                })
                .on_download(|webview, event| {
                    match event {
                        DownloadEvent::Requested { destination, .. } => {
                            let Ok(folder) = webview.app_handle().path().download_dir() else {
                                return false;
                            };
                            if std::fs::create_dir_all(&folder).is_err() {
                                return false;
                            }
                            let Some(name) = destination.file_name().map(|s| s.to_owned()) else {
                                return false;
                            };
                            let mut path = folder.join(&name);
                            // Repeated exports never overwrite an existing file.
                            let stem = path
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .into_owned();
                            let extension = path
                                .extension()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .into_owned();
                            let mut n = 1;
                            while path.exists() {
                                path = folder.join(format!("{stem} ({n}).{extension}"));
                                n += 1;
                            }
                            *destination = path;
                        }
                        DownloadEvent::Finished { success, .. } => {
                            let message = if success {
                                "PGN saved to Downloads"
                            } else {
                                "Export failed. Please try again."
                            };
                            let _ = webview
                                .eval(format!("if(typeof toast==='function')toast('{message}')"));
                        }
                        _ => {}
                    }
                    true
                })
                .on_navigation(move |target| {
                    if smoke && target.scheme() == "knightlight-smoke" {
                        if target.host_str() == Some("passed") {
                            println!("PASS: native webview loaded app, board, backend, disposable profile; audio muted");
                            smoke_handle.exit(0);
                        } else {
                            eprintln!("Native smoke test failed: {target}");
                            smoke_handle.exit(1);
                        }
                        return false;
                    }
                    // No privileged IPC is exposed. Keep navigation on our own
                    // server; deliberate external links open in the default browser.
                    if target.scheme() == "http"
                        && target.host_str() == Some("127.0.0.1")
                        && target.port() == Some(address.port())
                    {
                        return true;
                    }
                    if matches!(target.scheme(), "https" | "http") {
                        let _ = open::that(target.as_str());
                    }
                    false
                })
                .build()?;
            #[cfg(target_os = "linux")]
            if smoke {
                window.with_webview(|webview| {
                    use webkit2gtk::WebViewExt;
                    webview.inner().set_is_muted(true);
                    assert!(webview.inner().is_muted());
                    println!("Native test webview mute verified");
                })?;
            }
            #[cfg(not(target_os = "linux"))]
            let _ = window;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not start Knightlight desktop")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                if (code.is_none() || code == Some(0)) && updates::install_on_exit(app) {
                    api.prevent_exit();
                }
            }
        });
}
