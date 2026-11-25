use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    process::{ChildStdin, Stdio},
    sync::mpsc::{self, Receiver},
    time::Duration,
};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evaluation {
    pub score: i32,
    pub mate: Option<i32>,
    pub pv: Vec<String>,
}
pub struct Engine {
    child: crate::runtime::WorkerProcess,
    input: ChildStdin,
    lines: Receiver<String>,
}
impl Engine {
    pub fn new() -> Result<Self, String> {
        let path = std::env::var_os("STOCKFISH")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                crate::runtime::resource(
                    if cfg!(windows) && crate::runtime::resource("bin/stockfish.exe").exists() {
                        "bin/stockfish.exe"
                    } else if crate::runtime::resource("bin/stockfish").exists() {
                        "bin/stockfish"
                    } else {
                        if cfg!(windows) {
                            "vendor/stockfish/usr/games/stockfish.exe"
                        } else {
                            "vendor/stockfish/usr/games/stockfish"
                        }
                    },
                )
            });
        let mut child = crate::runtime::quiet_command(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for l in BufReader::new(output).lines() {
                if let Ok(l) = l {
                    if tx.send(l).is_err() {
                        break;
                    }
                } else {
                    break;
                }
            }
        });
        let mut e = Self {
            child: crate::runtime::track_worker(child),
            input,
            lines,
        };
        e.send("uci")?;
        e.until("uciok")?;
        e.send("setoption name Threads value 1")?;
        e.send("setoption name Hash value 32")?;
        e.send("isready")?;
        e.until("readyok")?;
        Ok(e)
    }
    fn send(&mut self, s: &str) -> Result<(), String> {
        writeln!(self.input, "{s}")
            .and_then(|_| self.input.flush())
            .map_err(|e| e.to_string())
    }
    fn until(&mut self, end: &str) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();
        loop {
            let l = self
                .lines
                .recv_timeout(Duration::from_secs(30))
                .map_err(|_| "Engine timed out".to_string())?;
            let done = l.starts_with(end);
            lines.push(l);
            if done {
                return Ok(lines);
            }
        }
    }
    pub fn evaluate(&mut self, fen: &str, depth: u8, multi: u8) -> Result<Vec<Evaluation>, String> {
        self.send(&format!("setoption name MultiPV value {multi}"))?;
        self.send("setoption name Skill Level value 20")?;
        self.send(&format!("position fen {fen}"))?;
        self.send(&format!("go depth {depth}"))?;
        let lines = self.until("bestmove")?;
        parse_evaluations(&lines)
    }
}
fn parse_evaluations(lines: &[String]) -> Result<Vec<Evaluation>, String> {
    let mut values = BTreeMap::new();
    for l in lines {
        if l.split_whitespace()
            .any(|t| matches!(t, "lowerbound" | "upperbound"))
        {
            continue;
        }
        let t: Vec<_> = l.split_whitespace().collect();
        let Some(i) = t.iter().position(|x| *x == "score") else {
            continue;
        };
        let Some(p) = t.iter().position(|x| *x == "pv") else {
            continue;
        };
        if t.len() <= i + 2 {
            continue;
        }
        let Ok(n) = t[i + 2].parse::<i32>() else {
            continue;
        };
        let mate = (t[i + 1] == "mate").then_some(n);
        let score = if mate.is_some() {
            if n > 0 {
                10000 - n.min(999)
            } else {
                -10000 - n.max(-999)
            }
        } else {
            n
        };
        let rank = t
            .iter()
            .position(|x| *x == "multipv")
            .and_then(|k| t.get(k + 1))
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(1);
        values.insert(
            rank,
            Evaluation {
                score,
                mate,
                pv: t[p + 1..].iter().map(|x| x.to_string()).collect(),
            },
        );
    }
    if values.is_empty() {
        return Err("Engine returned no legal continuation".into());
    }
    let best = lines
        .iter()
        .find_map(|l| l.strip_prefix("bestmove "))
        .and_then(|s| s.split_whitespace().next());
    if best.is_some_and(|best| {
        values
            .get(&1)
            .and_then(|v| v.pv.first())
            .is_none_or(|pv| pv != best)
    }) {
        return Err("Engine score and final move disagree".into());
    }
    Ok(values.into_values().collect())
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.send("quit");
        self.child.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_are_not_mistaken_for_exact_scores() {
        let lines = [
            "info depth 10 score cp 24 pv e2e4 e7e5",
            "info depth 11 score cp 300 lowerbound pv d2d4",
            "bestmove e2e4",
        ]
        .map(String::from);
        let result = parse_evaluations(&lines).unwrap();
        assert_eq!(result[0].score, 24);
        assert_eq!(result[0].pv[0], "e2e4");
    }
    #[test]
    fn a_score_for_a_different_final_move_is_rejected() {
        let lines = ["info depth 10 score cp 24 pv e2e4", "bestmove d2d4"].map(String::from);
        assert!(parse_evaluations(&lines).is_err());
    }
}
