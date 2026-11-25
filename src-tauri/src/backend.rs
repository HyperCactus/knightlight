//! AppImage WebKit helpers use paths relative to AppRun's working directory.
//! Run the same Rust backend in a child so its writable profile has its own cwd.
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub fn needed() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("APPDIR").is_some()
}
pub fn worker_mode() -> bool {
    std::env::args().nth(1).as_deref() == Some("--knightlight-backend")
}

pub fn run_worker() -> std::io::Result<()> {
    let profile = std::env::var_os("KNIGHTLIGHT_PROFILE")
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::other("Backend requires an explicit profile"))?;
    chess_study::runtime::prepare_profile(&profile)?;
    let port_file = profile.join("desktop-port");
    let port = std::fs::read_to_string(&port_file)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(0);
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .or_else(|_| std::net::TcpListener::bind("127.0.0.1:0"))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    std::fs::write(port_file, port.to_string())?;
    // Parent death closes stdin too. Always release model/engine processes.
    std::thread::spawn(|| {
        let mut line = String::new();
        let _ = std::io::stdin().lock().read_line(&mut line);
        chess_study::runtime::shutdown_workers();
        std::process::exit(0);
    });
    println!("KNIGHTLIGHT_BACKEND_PORT={port}");
    std::io::stdout().flush()?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async { chess_study::serve(tokio::net::TcpListener::from_std(listener)?).await })
}

pub fn start(
    profile: &std::path::Path,
    app: &AppHandle,
) -> Result<String, Box<dyn std::error::Error>> {
    if needed() {
        let service = Backend::start(profile.to_owned(), app.clone())?;
        let url = service.url.clone();
        app.manage(service);
        return Ok(url);
    }
    chess_study::runtime::prepare_profile(profile)?;
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
    let handle = app.clone();
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
                let _ = std::fs::write(
                    error_log,
                    format!("Knightlight backend stopped: {result:?}\n"),
                );
                handle.exit(1);
            }
        }
    });
    Ok(url)
}

pub struct Backend {
    pub url: String,
    child: Arc<Mutex<Child>>,
    input: Mutex<Option<ChildStdin>>,
    stopping: Arc<AtomicBool>,
}
impl Backend {
    pub fn start(profile: PathBuf, app: AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(profile.join("data"))?;
        let error_log = profile.join("desktop-errors.log");
        let stderr = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&error_log)?;
        let mut child = chess_study::runtime::quiet_command(std::env::current_exe()?)
            .arg("--knightlight-backend")
            .env("KNIGHTLIGHT_PROFILE", &profile)
            .current_dir(&profile)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()?;
        let input = child.stdin.take();
        let stdout = child.stdout.take().ok_or("Backend stdout unavailable")?;
        let (sender, ready) = mpsc::channel();
        std::thread::spawn(move || {
            let mut sender = Some(sender);
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(port) = line.strip_prefix("KNIGHTLIGHT_BACKEND_PORT=") {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(port.parse::<u16>());
                    }
                } else {
                    let _ = writeln!(std::io::stdout(), "{line}");
                }
            }
        });
        let port = match ready.recv_timeout(Duration::from_secs(30)) {
            Ok(Ok(port)) if port >= 1024 => port,
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Backend failed to start; see desktop-errors.log".into());
            }
        };
        let backend = Self {
            url: format!("http://127.0.0.1:{port}"),
            child: Arc::new(Mutex::new(child)),
            input: Mutex::new(input),
            stopping: Arc::new(AtomicBool::new(false)),
        };
        let process = Arc::downgrade(&backend.child);
        let stopping = backend.stopping.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if stopping.load(Ordering::SeqCst) {
                    return;
                }
                let Some(process) = process.upgrade() else {
                    return;
                };
                let exited = process.lock().unwrap().try_wait();
                if !matches!(exited, Ok(None)) && !stopping.load(Ordering::SeqCst) {
                    if let Ok(mut log) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&error_log)
                    {
                        let _ = writeln!(log, "Backend exited unexpectedly: {exited:?}");
                    }
                    app.exit(1);
                    return;
                }
            }
        });
        Ok(backend)
    }
    pub fn stop(&self) {
        let mut input = self.input.lock().unwrap(); // serialize concurrent exit requests
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(mut pipe) = input.take() {
            let _ = writeln!(pipe, "quit");
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut process = self.child.lock().unwrap();
            if !matches!(process.try_wait(), Ok(None)) {
                return;
            }
            if Instant::now() >= deadline {
                let _ = process.kill();
                let _ = process.wait();
                return;
            }
            drop(process);
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        self.stop();
    }
}
pub fn shutdown(app: &AppHandle) {
    if let Some(backend) = app.try_state::<Backend>() {
        backend.stop();
    }
    chess_study::runtime::shutdown_workers();
}
