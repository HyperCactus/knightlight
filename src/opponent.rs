use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};
#[derive(Deserialize, Serialize)]
pub struct Candidate {
    pub uci: String,
    pub probability: f64,
}
#[derive(Deserialize)]
pub struct Policy {
    pub candidates: Vec<Candidate>,
    pub inference_ms: u64,
}
pub fn available() -> bool {
    (crate::runtime::resource("vendor/maia-model/maia3-5m.pt").exists()
        || crate::runtime::resource("vendor/maia-model/maia3-5m.onnx").exists())
        && crate::runtime::worker_available("opponent")
}
pub struct Opponent {
    child: Child,
    input: ChildStdin,
    lines: Receiver<String>,
}
impl Opponent {
    pub fn new() -> Result<Self, String> {
        let mut child = crate::runtime::worker("opponent")
            .env("HF_HUB_OFFLINE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| e.to_string())?;
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for l in BufReader::new(output).lines().map_while(Result::ok) {
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input,
            lines,
        })
    }
    pub fn policy(
        &mut self,
        fen: &str,
        moves: &[String],
        rating: i32,
        player_rating: i32,
    ) -> Result<Policy, String> {
        writeln!(self.input,"{}",serde_json::json!({"fen":fen,"moves":moves,"rating":rating,"player_rating":player_rating})).and_then(|_|self.input.flush()).map_err(|e|e.to_string())?;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(40) {
            let line = self
                .lines
                .recv_timeout(Duration::from_secs(40).saturating_sub(start.elapsed()))
                .map_err(|_| "Human opponent timed out")?;
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(e) = value.get("error") {
                    return Err(e.to_string());
                }
                return serde_json::from_value(value).map_err(|e| e.to_string());
            }
        }
        Err("Human opponent timed out".into())
    }
}
impl Drop for Opponent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// Precomputed Maia policies are bundled so the first turn never needs to load
// Python/PyTorch. Their probabilities remain rating-conditioned and varied.
#[derive(Deserialize)]
struct OpeningCache {
    positions: Vec<OpeningPolicy>,
}
#[derive(Deserialize)]
struct OpeningPolicy {
    fen: String,
    rating: i32,
    candidates: Vec<Candidate>,
}
fn opening_cache() -> &'static [OpeningPolicy] {
    static CACHE: std::sync::OnceLock<Vec<OpeningPolicy>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        serde_json::from_str::<OpeningCache>(include_str!("../data/bot-openings.json"))
            .expect("Bundled opening policies must be valid")
            .positions
    })
}
pub fn opening_policy(pos: &shakmaty::Chess, rating: i32) -> Option<Vec<(String, f64)>> {
    let fen = crate::fen(pos);
    let key = |s: &str| s.split_whitespace().take(4).collect::<Vec<_>>().join(" ");
    let position_key = key(&fen);
    let policies: Vec<_> = opening_cache()
        .iter()
        .filter(|p| key(&p.fen) == position_key)
        .collect();
    let lower = policies
        .iter()
        .copied()
        .filter(|p| p.rating <= rating)
        .max_by_key(|p| p.rating)
        .or_else(|| policies.first().copied())?;
    let upper = policies
        .iter()
        .copied()
        .filter(|p| p.rating >= rating)
        .min_by_key(|p| p.rating)
        .unwrap_or(lower);
    let ratio = if upper.rating == lower.rating {
        0.0
    } else {
        ((rating - lower.rating) as f64 / (upper.rating - lower.rating) as f64).clamp(0.0, 1.0)
    };
    let mut mixed = std::collections::BTreeMap::<String, f64>::new();
    for (policy, weight) in [(lower, 1.0 - ratio), (upper, ratio)] {
        for candidate in &policy.candidates {
            *mixed.entry(candidate.uci.clone()).or_default() += candidate.probability * weight;
        }
    }
    Some(
        mixed
            .into_iter()
            .filter(|(_, probability)| *probability > 0.0)
            .collect(),
    )
}

pub fn sample(
    pos: &shakmaty::Chess,
    mut weighted: Vec<(String, f64)>,
    style: &str,
) -> Result<(String, usize), String> {
    use rand::Rng;
    use shakmaty::Position;
    weighted.retain_mut(|(u, w)| {
        if !w.is_finite() || *w <= 0.0 {
            return false;
        }
        let mut after = pos.clone();
        let Ok(m) = crate::training::play(&mut after, u) else {
            return false;
        };
        if style == "attacking" {
            if m.is_capture() {
                *w *= 1.25;
            }
            if after.is_check() {
                *w *= 1.3;
            }
        }
        if style == "positional" {
            if m.is_castle() {
                *w *= 1.4;
            }
            if ["d4", "e4", "d5", "e5"].contains(&m.to().to_string().as_str()) {
                *w *= 1.15;
            }
        }
        true
    });
    let sum: f64 = weighted.iter().map(|x| x.1).sum();
    if !sum.is_finite() || sum <= 0.0 {
        return Err("No legal opponent candidate".into());
    }
    let mut roll = rand::rng().random_range(0.0..sum);
    let mut chosen = weighted.last().unwrap().0.clone();
    for (u, w) in &weighted {
        roll -= w;
        if roll <= 0.0 {
            chosen = u.clone();
            break;
        }
    }
    Ok((chosen, weighted.len()))
}

pub fn warm(app: &crate::Shared) {
    use std::sync::atomic::Ordering;
    if !available() {
        return;
    }
    app.opponent_status.store(1, Ordering::Release);
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let mut guard = app.opponent.lock().unwrap();
        let result = (|| {
            let mut worker = Opponent::new()?;
            worker.policy(&crate::fen(&shakmaty::Chess::default()), &[], 1200, 1100)?;
            *guard = Some(worker);
            Ok::<_, String>(())
        })();
        match result {
            Ok(()) => {
                app.opponent_status.store(2, Ordering::Release);
                eprintln!(
                    "Human opponent ready in {} ms",
                    started.elapsed().as_millis()
                );
            }
            Err(error) => {
                *guard = None;
                app.opponent_status.store(3, Ordering::Release);
                eprintln!("Human opponent warm-up failed: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_policies_cover_every_first_move_and_only_contain_legal_moves() {
        use shakmaty::Position;
        let start = shakmaty::Chess::default();
        for movement in start.legal_moves() {
            let mut pos = start.clone();
            pos.play_unchecked(movement);
            for rating in [400, 1000, 1600, 2400] {
                let cached = opening_policy(&pos, rating).expect("Every first move is cached");
                assert!(cached.len() > 1);
            }
        }
        for entry in opening_cache() {
            let pos = crate::position(&entry.fen).unwrap();
            for c in &entry.candidates {
                assert!(c.probability.is_finite() && c.probability > 0.0);
                assert!(crate::training::play(&mut pos.clone(), &c.uci).is_ok());
            }
        }
    }
    #[test]
    fn invalid_candidates_are_never_sampled_and_unknown_positions_have_no_book() {
        let pos = shakmaty::Chess::default();
        let (chosen, count) = sample(
            &pos,
            vec![
                ("e2e5".into(), 100.0),
                ("d2d4".into(), f64::NAN),
                ("e2e4".into(), 1.0),
            ],
            "balanced",
        )
        .unwrap();
        assert_eq!(chosen, "e2e4");
        assert_eq!(count, 1);
        let mut later = pos;
        for u in ["e2e4", "e7e5", "d2d4", "e5d4", "d1d4"] {
            crate::training::play(&mut later, u).unwrap();
        }
        assert!(opening_policy(&later, 1200).is_none());
    }
}
