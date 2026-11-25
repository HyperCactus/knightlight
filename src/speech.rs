use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Write},
    process::{ChildStdin, Stdio},
    sync::mpsc::{self, Receiver},
    time::Duration,
};

pub fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn selected_voice(voice: &str) -> &str {
    if voice == "piper"
        && !crate::runtime::resource(
            "vendor/voices/en/en_US/lessac/medium/en_US-lessac-medium.onnx",
        )
        .exists()
        && crate::runtime::resource("vendor/kokoro/onnx/model_quantized.onnx").exists()
    {
        return "af_heart";
    }
    if voice != "piper"
        && !crate::runtime::resource("vendor/kokoro/onnx/model_quantized.onnx").exists()
    {
        "piper"
    } else {
        voice
    }
}

pub fn cache_name(text: &str, voice: &str) -> String {
    format!(
        "{:x}.wav",
        Sha256::digest(format!("coach-v5:{voice}:{}", normalize(text)))
    )
}

// Cache hits bypass the Python worker and its synthesis lock completely. A
// ready phrase must not queue behind unrelated speculative inference.
pub fn cached(text: &str, voice: &str) -> Option<serde_json::Value> {
    let voice = selected_voice(voice);
    let name = cache_name(text, voice);
    let path = std::path::Path::new("data/audio").join(&name);
    let metadata = std::fs::metadata(&path).ok()?;
    if metadata.len() <= 44 {
        return None;
    }
    if metadata.modified().ok()?.elapsed().ok()?.as_secs() > 60 {
        if let Ok(file) = std::fs::File::open(&path) {
            let _ = file
                .set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()));
        }
    }
    Some(serde_json::json!({
        "url": format!("/audio/{name}"), "engine": if voice == "piper" { "piper" } else { "kokoro" },
        "voice": voice, "cached": true, "synthesis_ms": 0
    }))
}

pub fn warm(app: &crate::Shared) {
    let voice = app
        .preferences
        .lock()
        .unwrap()
        .snapshot
        .as_ref()
        .and_then(|s| s.values.get("voiceName"))
        .and_then(|v| v.as_str())
        .unwrap_or("af_heart")
        .to_owned();
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = app.speech.lock().unwrap();
        let result = (|| {
            if guard.is_none() {
                *guard = Some(Speech::new()?);
            }
            // Warm neural inference even if this familiar phrase is cached.
            guard
                .as_mut()
                .unwrap()
                .request(serde_json::json!({"warm":true,"voice":voice}))
        })();
        if let Err(error) = result {
            eprintln!("Speech warm-up unavailable (will retry on demand): {error}");
            *guard = None;
        }
    });
}
pub struct Speech {
    _child: crate::runtime::WorkerProcess,
    input: ChildStdin,
    output: Receiver<String>,
}
impl Speech {
    pub fn new() -> Result<Self, String> {
        let mut child = crate::runtime::worker("speech")
            .env("OMP_NUM_THREADS", "4")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| e.to_string())?;
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for l in BufReader::new(stdout).lines() {
                if let Ok(l) = l {
                    if tx.send(l).is_err() {
                        break;
                    }
                } else {
                    break;
                }
            }
        });
        Ok(Self {
            _child: crate::runtime::track_worker(child),
            input,
            output,
        })
    }
    pub fn speak(&mut self, text: &str, voice: &str) -> Result<serde_json::Value, String> {
        self.request(serde_json::json!({"text":text,"voice":voice}))
    }
    fn request(&mut self, request: serde_json::Value) -> Result<serde_json::Value, String> {
        writeln!(self.input, "{}", request)
            .and_then(|_| self.input.flush())
            .map_err(|e| e.to_string())?;
        let line = self
            .output
            .recv_timeout(Duration::from_secs(45))
            .map_err(|_| "Local voice timed out".to_string())?;
        let value: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        if let Some(e) = value.get("error") {
            return Err(e.to_string());
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn python_compatible_cache_keys_are_normalized_and_voice_specific() {
        assert_eq!(
            cache_name("Your move.", "af_heart"),
            "b437bfe01fd608211bffbcd1adc2134e1fbf71136850343ed5376d926bd2bdf7.wav"
        );
        assert_eq!(
            cache_name(" Your\n move.  ", "af_heart"),
            cache_name("Your move.", "af_heart")
        );
        assert_ne!(
            cache_name("Your move.", "af_heart"),
            cache_name("Your move.", "bf_emma")
        );
    }
}
