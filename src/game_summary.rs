//! Post-game coaching from the recorded result and the full move review.
use crate::{position, training::Review, Game};
use serde::Serialize;
use shakmaty::{Position, Role};

#[derive(Serialize)]
pub struct GameSummary {
    pub verdict: &'static str,
    pub title: &'static str,
    pub story: String,
    pub takeaway: String,
    pub key_ply: Option<usize>,
    pub accuracy: f64,
    pub mistakes: usize,
    pub blunders: usize,
    pub moves: usize,
}
fn endgame(fen: &str) -> bool {
    position(fen).is_ok_and(|p| {
        p.board().queens().is_empty()
            && p.board()
                .occupied()
                .into_iter()
                .filter(|s| !matches!(p.board().role_at(*s), Some(Role::Pawn | Role::King)))
                .count()
                <= 4
    })
}
pub fn summarize(game: &Game, review: &Review, player: &str) -> Option<GameSummary> {
    let white = game.white.eq_ignore_ascii_case(player);
    if !white && !game.black.eq_ignore_ascii_case(player) {
        return None;
    }
    let verdict = match game.result.as_str() {
        "1/2-1/2" => "draw",
        "1-0" if white => "win",
        "0-1" if !white => "win",
        "1-0" | "0-1" => "loss",
        _ => return None,
    };
    let sign = if white { 1 } else { -1 };
    let scores: Vec<_> = review.moves.iter().map(|m| m.eval_after * sign).collect();
    let last = review.moves.last();
    let mate = last.is_some_and(|m| position(&m.after).is_ok_and(|p| p.is_checkmate()));
    let worst = review
        .moves
        .iter()
        .filter(|m| m.player && m.loss > 80)
        .max_by_key(|m| m.loss);
    // A sustained lead must survive at least four full moves, including the opponent's replies.
    let held = scores.iter().enumerate().find(|(i, score)| {
        **score >= 150 && scores.len() - i >= 8 && scores[*i..].iter().all(|s| *s >= 100)
    });
    let comeback = scores.iter().any(|s| *s <= -200);
    let long_endgame = review
        .moves
        .iter()
        .rev()
        .take_while(|m| endgame(&m.after))
        .count()
        >= 20;
    let mut story = match verdict {
        "win" if comeback => {
            "You turned a difficult position around and went on to win.".to_string()
        }
        "win" if held.is_some() => {
            let (i, _) = held.unwrap();
            format!(
                "You built an advantage {} and held onto it through the finish.",
                if i < 20 {
                    "in the opening"
                } else if endgame(&review.moves[i].before) {
                    "in the endgame"
                } else {
                    "in the middlegame"
                }
            )
        }
        "win" => "Well played — you found a way to finish the game in your favor.".into(),
        "loss" if scores.iter().any(|s| *s >= 200) => {
            "You had an advantage earlier, but the game turned in your opponent's favor.".into()
        }
        "loss" if worst.is_some() => {
            "There is a missed opportunity worth revisiting in this game.".into()
        }
        "loss" => {
            "Your opponent came out on top. There is a useful lesson to take into the next game."
                .into()
        }
        "draw" if comeback => "You recovered from a difficult position to secure a draw.".into(),
        "draw" if scores.iter().any(|s| *s >= 200) => {
            "You had chances to press an advantage, but the game finished level.".into()
        }
        _ => "The game finished level, with neither side taking the full point.".into(),
    };
    if mate {
        story.push_str(match (verdict, long_endgame) {
            ("win", true) => " You finished a long endgame with checkmate.",
            ("win", false) => " You finished with checkmate.",
            ("loss", true) => " The long endgame ended with your king caught in a mating net.",
            ("loss", false) => " The final attack ended in checkmate.",
            _ => "",
        });
    } else if verdict == "draw" {
        if let Some(p) = last.and_then(|m| position(&m.after).ok()) {
            if p.is_stalemate() {
                story.push_str(" The final position was stalemate.");
            } else if p.is_insufficient_material() {
                story.push_str(" Neither side had enough material to force mate.");
            }
        }
    }
    let (takeaway, key_ply) = if let Some(m) = worst {
        (
            format!(
                "Revisit move {}: {}. Look for {} before committing.",
                m.ply / 2 + 1,
                m.san,
                match m.theme.as_str() {
                    "King safety" | "Checkmate patterns" => "your opponent's forcing threats",
                    "Material & captures" => "the full capture and recapture sequence",
                    "Forks & double attacks" => "pieces that can be attacked together",
                    "Pins" => "pieces tied to defending the king",
                    _ => "your opponent's strongest reply",
                }
            ),
            Some(m.ply + 1),
        )
    } else {
        (
            if verdict == "win" {
                "Replay the finish and remember the idea that made it work."
            } else {
                "Review the key positions and choose one idea to practice next."
            }
            .into(),
            last.map(|m| m.ply + 1),
        )
    };
    Some(GameSummary {
        verdict,
        title: match verdict {
            "win" => "You won!",
            "loss" => "A lesson for the next game",
            _ => "A hard-fought draw",
        },
        story,
        takeaway,
        key_ply,
        accuracy: review.accuracy,
        mistakes: review.mistakes,
        blunders: review.blunders,
        moves: game.moves.len().div_ceil(2),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{engine::Evaluation, training};
    use shakmaty::Color;
    fn fixture(result: &str, player: &str, scores: &[i32]) -> (Game, Review) {
        let moves = ["g1f3", "g8f6", "f3g1", "f6g8"]
            .into_iter()
            .cycle()
            .take(scores.len())
            .map(String::from)
            .collect::<Vec<_>>();
        let game = Game {
            white: "White".into(),
            black: "Black".into(),
            result: result.into(),
            moves: moves.clone(),
            ..Game::default()
        };
        let mut p = shakmaty::Chess::default();
        let mut records = vec![];
        for (i, u) in moves.iter().enumerate() {
            let eval = Evaluation {
                score: 0,
                mate: None,
                pv: vec![u.clone()],
            };
            let mut m = training::describe(
                &p,
                u,
                &eval,
                &eval,
                i,
                (p.turn() == Color::White) == (player == "White"),
            );
            m.eval_after = scores[i];
            records.push(m);
            training::play(&mut p, u).unwrap();
        }
        (
            game,
            Review {
                moves: records,
                accuracy: 97.0,
                blunders: 0,
                mistakes: 0,
                depth: 10,
                analysis_version: 1,
            },
        )
    }
    #[test]
    fn a_sustained_opening_lead_is_distinct_from_a_comeback() {
        let (g, r) = fixture("1-0", "White", &[200; 12]);
        let s = summarize(&g, &r, "White").unwrap();
        assert!(s.story.contains("in the opening"));
        assert!(!s.story.contains("checkmate"));
        let (g, r) = fixture("1-0", "White", &[200, 200, 200, -250, -250, 0, 250, 250]);
        let s = summarize(&g, &r, "White").unwrap();
        assert!(s.story.contains("turned a difficult position"));
        assert!(!s.story.contains("held onto"));
    }
    #[test]
    fn black_perspective_and_draws_do_not_receive_a_victory_summary() {
        let (g, r) = fixture("1-0", "Black", &[200; 12]);
        assert_eq!(summarize(&g, &r, "Black").unwrap().verdict, "loss");
        let (g, r) = fixture("1/2-1/2", "Black", &[0; 12]);
        let s = summarize(&g, &r, "Black").unwrap();
        assert_eq!(s.verdict, "draw");
        assert!(!s.story.contains("checkmate"));
        let (g, r) = fixture("*", "White", &[0; 12]);
        assert!(summarize(&g, &r, "White").is_none());
    }
}
