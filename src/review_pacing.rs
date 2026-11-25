//! Estimate the visual reading effort of a reviewed move without another engine
//! search. This is a teaching heuristic, not a claim about a person's ability.
use crate::{position, tactics::EvidenceContext, training::ReviewMove};
use serde::{Deserialize, Serialize};
use shakmaty::{Color, Position, Rank, Role};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pace {
    /// Relative to the user's reading pause; animation and speech are separate.
    pub multiplier: f64,
    pub complexity: u8,
    pub signals: Vec<String>,
}
impl Default for Pace {
    fn default() -> Self {
        Self {
            multiplier: 1.0,
            complexity: 33,
            signals: vec![],
        }
    }
}
fn result(score: i32, signals: Vec<&str>) -> Pace {
    let complexity = score.clamp(0, 100) as u8;
    Pace {
        multiplier: ((0.5 + f64::from(complexity) * 0.015) * 100.0).round() / 100.0,
        complexity,
        signals: signals.into_iter().map(str::to_string).collect(),
    }
}
pub fn assess(m: &ReviewMove, previous: Option<&ReviewMove>) -> Pace {
    let (Ok(before), Ok(after)) = (position(&m.before), position(&m.after)) else {
        return Pace::default();
    };
    let mut replay = before.clone();
    let Ok(played) = crate::training::play(&mut replay, &m.uci) else {
        return Pace::default();
    };
    let facts: Vec<_> = m
        .evidence
        .iter()
        .filter(|f| {
            // A continuation offered as an alternative is relevant for mistakes,
            // but should not make a routine sound move seem complicated.
            m.loss > 80 || matches!(f.context, Some(EvidenceContext::Played))
        })
        .collect();
    let motifs = facts
        .iter()
        .filter(|f| {
            matches!(
                f.theme.as_str(),
                "Forks & double attacks" | "Pins" | "King safety" | "Checkmate patterns"
            ) && !(f.theme == "King safety" && played.is_castle() && !after.is_check())
        })
        .count();
    let delayed = facts
        .iter()
        .any(|f| f.outlook.as_ref().is_some_and(|o| o.steps.len() >= 2));
    let exchange = facts.iter().any(|f| f.follow_up.len() >= 2);
    // A mate already available is different from a new mating threat allowed by
    // this move. Avoid slowing every subsequent forced move in the same attack.
    let new_mate = m.loss > 80 && m.mate.is_some_and(|n| n > 0);
    let mating_idea = m.best == m.uci && m.best_mate.is_some_and(|n| n > 1);
    let promotion = played.is_promotion();
    let recapture = previous.is_some_and(|p| {
        p.after == m.before && p.san.contains('x') && p.uci.get(2..4) == m.uci.get(2..4)
    });
    let simple = m.loss <= 35 && motifs == 0 && !delayed && !new_mate && !mating_idea && !promotion;
    if simple && before.legal_moves().len() == 1 {
        return result(0, vec!["Only legal reply"]);
    }
    if simple && recapture {
        return result(0, vec!["Straightforward recapture"]);
    }
    let (home, pawn_home) = if before.turn() == Color::White {
        (Rank::First, Rank::Second)
    } else {
        (Rank::Eighth, Rank::Seventh)
    };
    let development = played.from().is_some_and(|from| match played.role() {
        Role::Pawn => from.rank() == pawn_home,
        Role::Knight | Role::Bishop => from.rank() == home,
        _ => false,
    });
    if simple
        && m.ply < 16
        && played.capture().is_none()
        && !after.is_check()
        && (played.is_castle() || development)
    {
        return result(0, vec!["Routine opening development"]);
    }
    let mut score = 33;
    let mut signals = vec![];
    if m.loss > 80 {
        score += if m.loss > 300 {
            42
        } else if m.loss > 150 {
            28
        } else {
            16
        };
        signals.push("Compare the move with a better plan");
    }
    // White-perspective evaluations can be compared directly. Exclude mate
    // sentinels: their large values are not centipawn swings.
    if m.eval_before.abs() < 9000 && m.eval_after.abs() < 9000 {
        let swing = (m.eval_after - m.eval_before).abs();
        if swing >= 120 {
            score += (swing / 35).min(14);
            signals.push("The balance changes");
        }
        if m.eval_before.signum() != m.eval_after.signum()
            && m.eval_before.abs() >= 100
            && m.eval_after.abs() >= 100
        {
            score += 10;
            signals.push("The advantage changes sides");
        }
    }
    if motifs > 0 {
        score += 18 + (motifs.saturating_sub(1).min(2) as i32) * 5;
        signals.push("Tactical relationships to inspect");
    }
    if delayed || exchange {
        score += if delayed { 20 } else { 16 };
        signals.push("The consequence takes several moves");
    }
    if new_mate || mating_idea {
        score += 30;
        signals.push("A forcing mating idea");
    }
    if promotion {
        score += 25;
        signals.push("Promotion changes the position");
    }
    if played.capture().is_none()
        && !after.is_check()
        && facts.iter().any(|f| {
            matches!(
                f.theme.as_str(),
                "Open files" | "Passed pawns" | "Endgame technique"
            )
        })
    {
        score += 13;
        signals.push("A quiet positional plan");
    }
    if after.is_check() && !after.is_checkmate() {
        score += 7;
        signals.push("Check changes the reply options");
    }
    // Several available captures create visual tension even on an otherwise
    // quiet move. Count legal captures, rather than geometric pseudo-threats.
    if after
        .legal_moves()
        .iter()
        .filter(|reply| reply.capture().is_some())
        .count()
        >= 3
    {
        score += 8;
        signals.push("Several exchanges are possible");
    }
    if signals.is_empty() {
        signals.push("Follow the piece activity");
    }
    result(score, signals)
}

pub fn refresh(moves: &mut [ReviewMove]) {
    for i in 0..moves.len() {
        let pace = assess(&moves[i], i.checked_sub(1).map(|j| &moves[j]));
        moves[i].review_pace = pace;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{engine::Evaluation, training};
    fn move_record(fen: &str, uci: &str, best: &str, loss: i32, ply: usize) -> ReviewMove {
        training::describe(
            &position(fen).unwrap(),
            uci,
            &Evaluation {
                score: 50,
                mate: None,
                pv: vec![best.into()],
            },
            &Evaluation {
                score: loss - 50,
                mate: None,
                pv: vec![],
            },
            ply,
            true,
        )
    }
    #[test]
    fn routine_opening_and_only_legal_reply_get_the_shortest_pause() {
        let opening = move_record(
            &crate::fen(&shakmaty::Chess::default()),
            "e2e4",
            "e2e4",
            0,
            0,
        );
        assert_eq!(opening.review_pace.multiplier, 0.5);
        let castle = move_record(
            "r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 5",
            "e1g1",
            "e1g1",
            0,
            8,
        );
        assert_eq!(castle.review_pace.multiplier, 0.5);
        let forced = move_record("7k/8/5K2/8/8/8/8/7R b - - 0 30", "h8g8", "h8g8", 0, 59);
        assert_eq!(position(&forced.before).unwrap().legal_moves().len(), 1);
        assert_eq!(forced.review_pace.multiplier, 0.5);
    }
    #[test]
    fn a_new_mating_blunder_gets_twice_the_reading_time_even_in_the_opening() {
        let mut m = move_record(
            "rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2",
            "g2g4",
            "e2e4",
            500,
            2,
        );
        m.mate = Some(1);
        training::enrich(&mut m);
        assert_eq!(m.review_pace.multiplier, 2.0);
    }
    #[test]
    fn ordinary_recapture_is_short_but_an_error_does_not_get_hidden() {
        // A legal exchange with a defender on the same file.
        let first = move_record("3rk3/8/8/3p4/8/8/8/3QK3 w - - 0 20", "d1d5", "d1d5", 0, 38);
        let mut reply = move_record(&first.after, "d8d5", "d8d5", 0, 39);
        assert_eq!(assess(&reply, Some(&first)).multiplier, 0.5);
        reply.loss = 301;
        assert!(assess(&reply, Some(&first)).multiplier > 1.5);
    }
    #[test]
    fn delayed_strong_moves_need_time_without_being_mistakes() {
        let before = position("3r3k/6pp/8/4N3/8/8/P7/6K1 w - - 0 12").unwrap();
        let a = Evaluation {
            score: 600,
            mate: None,
            pv: vec!["e5f7".into(), "h8g8".into(), "f7d8".into()],
        };
        let b = Evaluation {
            score: -600,
            mate: None,
            pv: vec!["h8g8".into(), "f7d8".into()],
        };
        // Full evidence comes from the same legal engine-line representation as reviews.
        let m = training::describe(&before, "e5f7", &a, &b, 22, true);
        assert!(m.review_pace.multiplier >= 1.5, "{:?}", m.review_pace);
        assert_eq!(m.loss, 0);
    }
    #[test]
    fn an_advanced_pawn_is_not_mistaken_for_routine_development() {
        let m = move_record("7k/8/P7/8/8/8/8/6K1 w - - 0 3", "a6a7", "a6a7", 0, 4);
        assert!(m.review_pace.multiplier > 1.0);
        assert!(!m
            .review_pace
            .signals
            .iter()
            .any(|s| s.contains("Routine opening")));
    }
    #[test]
    fn legacy_defaults_are_neutral_and_all_factors_are_bounded() {
        assert_eq!(Pace::default().multiplier, 1.0);
        for score in [-50, 0, 33, 100, 10000] {
            let pace = result(score, vec![]);
            assert!((0.5..=2.0).contains(&pace.multiplier));
        }
    }
}
