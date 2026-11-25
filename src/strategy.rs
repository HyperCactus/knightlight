//! Concise plans grounded in board changes and a replayed principal variation.
use crate::{exchange, fen, tactics, training};
use serde::{Deserialize, Serialize};
use shakmaty::{Bitboard, Chess, Color, Position, Role, Square};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Outlook {
    pub title: String,
    pub text: String,
    pub steps: Vec<tactics::ContinuationStep>,
}

fn material(p: &Chess, color: Color) -> i32 {
    p.board()
        .by_color(color)
        .into_iter()
        .map(|s| exchange::value(p.board().role_at(s).unwrap()))
        .sum()
}
fn balance(p: &Chess, us: Color) -> i32 {
    material(p, us) - material(p, !us)
}
fn reward(before: &Chess, after: &Chess, us: Color) -> &'static str {
    let roles = [
        Role::Pawn,
        Role::Knight,
        Role::Bishop,
        Role::Rook,
        Role::Queen,
    ];
    let delta: Vec<_> = roles
        .iter()
        .map(|role| {
            let count = |p: &Chess| {
                (p.board().by_role(*role) & p.board().by_color(us)).count() as i32
                    - (p.board().by_role(*role) & p.board().by_color(!us)).count() as i32
            };
            count(after) - count(before)
        })
        .collect();
    match delta.as_slice() {
        [1, 0, 0, 0, 0] => "wins a pawn",
        [2, 0, 0, 0, 0] => "gains two pawns",
        [0, 1, 0, 0, 0] => "wins the knight",
        [0, 0, 1, 0, 0] => "wins the bishop",
        [0, 0, 0, 1, 0] => "wins the rook",
        [0, 0, 0, 0, 1] => "wins the queen",
        [0, -1, 0, 1, 0] | [0, 0, -1, 1, 0] => "wins the exchange: a rook for a minor piece",
        _ => "comes out ahead in material",
    }
}
fn developed(p: &Chess, us: Color) -> usize {
    let home = if us == Color::White { 0 } else { 7 };
    p.board()
        .by_color(us)
        .into_iter()
        .filter(|s| {
            matches!(p.board().role_at(*s), Some(Role::Knight | Role::Bishop))
                && s.rank() as u32 != home
        })
        .count()
}
fn passed(p: &Chess, s: Square, us: Color) -> bool {
    p.board().by_color(!us).into_iter().all(|other| {
        p.board().role_at(other) != Some(Role::Pawn)
            || (other.file() as i32 - s.file() as i32).abs() > 1
            || if us == Color::White {
                other.rank() <= s.rank()
            } else {
                other.rank() >= s.rank()
            }
    })
}
fn set_text(f: &mut tactics::Evidence, title: &str, text: String, theme: &str) {
    f.title = title.into();
    f.text = text.clone();
    f.spoken_text = Some(text);
    f.theme = theme.into();
}
fn add_arrow(f: &mut tactics::Evidence, from: Square, to: Square, kind: &str) {
    for s in [from, to] {
        if !f.squares.contains(&s.to_string()) {
            f.squares.push(s.to_string());
        }
    }
    f.arrows.push(tactics::Arrow {
        from: from.to_string(),
        to: to.to_string(),
        kind: kind.into(),
    });
}

/// Improve quiet-move descriptions with a concrete reason visible on this board.
fn purpose(before: &Chess, uci: &str, fact: &mut tactics::Evidence) {
    if fact.theme != "Piece activity" && fact.theme != "Endgame technique" {
        return;
    }
    let mut after = before.clone();
    let Ok(m) = training::play(&mut after, uci) else {
        return;
    };
    if m.is_promotion() || !fact.follow_up.is_empty() || fact.spoken_text.is_some() {
        return;
    }
    let us = before.turn();
    let from = m.from().unwrap();
    let to = m.to();
    let b = after.board();
    let new_attack = fact
        .arrows
        .iter()
        .filter(|a| a.kind == "pressure")
        .filter_map(|a| a.to.parse::<Square>().ok())
        .filter(|s| b.role_at(*s).is_some_and(|r| exchange::value(r) >= 320))
        .max_by_key(|s| exchange::value(b.role_at(*s).unwrap()));
    if m.role() != Role::King {
        if let Ok(enemy_turn) = before.clone().swap_turn() {
            let threatened = exchange::recaptures(&enemy_turn, from)
                .into_iter()
                .find(|capture| {
                    exchange::after_move(
                        &enemy_turn,
                        &shakmaty::uci::UciMove::from_standard(*capture).to_string(),
                    )
                    .is_some_and(|e| e.net > 50)
                });
            let safe = exchange::recaptures(&after, to).iter().all(|capture| {
                exchange::after_move(
                    &after,
                    &shakmaty::uci::UciMove::from_standard(*capture).to_string(),
                )
                .is_none_or(|e| e.net <= 50)
            });
            if let Some(attacker) = threatened.filter(|_| safe) {
                set_text(
                    fact,
                    "Move out of danger",
                    format!(
                        "The {} escapes the attack from the {} on {}, preserving material.",
                        tactics::name(m.role()),
                        tactics::name(attacker.role()),
                        attacker.from().unwrap()
                    ),
                    "Defense",
                );
                fact.arrows.clear();
                fact.squares = vec![to.to_string()];
                add_arrow(fact, from, to, "move");
                fact.squares.push(attacker.from().unwrap().to_string());
                if let Some(target) = new_attack {
                    fact.text.push_str(&format!(
                        " It also attacks the {} on {target}.",
                        tactics::name(b.role_at(target).unwrap())
                    ));
                    fact.spoken_text = Some(fact.text.clone());
                    add_arrow(fact, to, target, "pressure");
                }
                return;
            }
        }
    }
    // A direct attack on a piece is more relevant than a generic positional benefit.
    if new_attack.is_some() {
        return;
    }
    if m.role() == Role::King && b.occupied().count() <= 12 {
        let distance = |a: Square, b: Square| {
            (a.file() as i32 - b.file() as i32)
                .abs()
                .max((a.rank() as i32 - b.rank() as i32).abs())
        };
        if let Some(pawn) = b
            .pawns()
            .into_iter()
            .filter(|s| distance(to, *s) < distance(from, *s))
            .min_by_key(|s| distance(to, *s))
        {
            let text = if b.color_at(pawn) == Some(us) {
                format!("The king moves closer to its pawn on {pawn} to support it.")
            } else {
                format!("The king approaches the opponent's pawn on {pawn}, bringing it into the endgame fight.")
            };
            set_text(fact, "Activate the king", text, "Endgame technique");
            fact.squares = vec![to.to_string(), pawn.to_string()];
            fact.arrows.clear();
            return;
        }
    }
    if m.role() == Role::Pawn && passed(&after, to, us) {
        let remaining = if us == Color::White {
            7 - to.rank() as u32
        } else {
            to.rank() as u32
        };
        if remaining <= 4 {
            set_text(fact, "Advance the passer", format!("The passed pawn on {to} is {remaining} {} from promotion, with no enemy pawns ahead on its own or neighboring files.", if remaining == 1 { "square" } else { "squares" }), "Passed pawns");
            fact.arrows.clear();
            fact.squares = vec![to.to_string()];
            let next = Square::new((to as i32 + if us == Color::White { 8 } else { -8 }) as u32);
            if b.piece_at(next).is_none() {
                add_arrow(fact, to, next, "move");
            }
            return;
        }
    }
    if m.role() == Role::Rook {
        let pawns: Vec<_> = b
            .pawns()
            .into_iter()
            .filter(|s| s.file() == to.file())
            .collect();
        if pawns.iter().all(|s| b.color_at(*s) != Some(us)) && from.file() != to.file() {
            let text = if pawns.is_empty() {
                format!("The rook takes the open {}-file, with no pawns blocking its path into the opponent's position.", to.file())
            } else {
                format!("The rook takes the half-open {}-file, lining up against the opponent's pawn structure.", to.file())
            };
            set_text(fact, "Use the file", text, "Open files");
            fact.arrows.clear();
            fact.squares = vec![to.to_string()];
            // Only highlight the actual unobstructed rook ray.
            if let Some(target) = b
                .attacks_from(to)
                .into_iter()
                .filter(|s| {
                    s.file() == to.file()
                        && if us == Color::White {
                            s.rank() > to.rank()
                        } else {
                            s.rank() < to.rank()
                        }
                })
                .max_by_key(|s| (s.rank() as i32 - to.rank() as i32).abs())
            {
                add_arrow(fact, to, target, "control");
            }
            return;
        }
    }
    if m.role() == Role::Pawn {
        for bishop in b.by_color(us) & b.bishops() {
            let new_scope =
                b.attacks_from(bishop) & !b.by_color(us) & !before.board().attacks_from(bishop);
            if new_scope.count() >= 2 {
                set_text(fact, "Free the bishop", format!("Moving this pawn opens the bishop's diagonal from {bishop}, giving it more room to develop or join the attack."), "Piece activity");
                fact.arrows.clear();
                fact.squares = vec![to.to_string()];
                for target in new_scope {
                    add_arrow(fact, bishop, target, "control");
                }
                return;
            }
        }
    }
    if matches!(m.role(), Role::Knight | Role::Bishop)
        && developed(&after, us) > developed(before, us)
        && before.fullmoves().get() <= 10
    {
        // Mention a real attack if present; otherwise explain development once, on request.
        if fact.arrows.iter().any(|a| a.kind == "pressure") {
            return;
        }
        let center: Bitboard = [Square::D4, Square::E4, Square::D5, Square::E5]
            .into_iter()
            .collect();
        let controls = b.attacks_from(to) & center;
        let text = if controls.is_empty() {
            format!(
                "The {} develops from {from}, bringing another piece into play.",
                tactics::name(m.role())
            )
        } else {
            format!(
                "The {} develops toward the center and controls {}.",
                tactics::name(m.role()),
                controls
                    .into_iter()
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
                    .join(" and ")
            )
        };
        set_text(fact, "Develop with purpose", text, "Piece activity");
    }
}

/// The endpoint must not stop halfway through a profitable recapture.
fn settled(p: &Chess) -> bool {
    !p.is_check()
        && !p.legal_moves().iter().any(|m| {
            m.is_capture()
                && exchange::after_move(p, &shakmaty::uci::UciMove::from_standard(*m).to_string())
                    .is_some_and(|e| e.net > 50)
        })
}

pub fn enrich(facts: &mut [tactics::Evidence], before: &Chess, line: &[training::LineMove]) {
    let Some(first) = line.first() else {
        return;
    };
    let Some(fact) = facts.first_mut() else {
        return;
    };
    if fact.uci.as_deref() != Some(&first.uci) {
        return;
    }
    // Replay rather than trusting serialized cached positions.
    let mut p = before.clone();
    let mut positions = vec![];
    for step in line.iter().take(6) {
        if training::play(&mut p, &step.uci).is_err() || fen(&p) != step.fen {
            return;
        }
        positions.push(p.clone());
    }
    purpose(before, &first.uci, fact);
    if positions.len() < 3 || positions[0].is_checkmate() || fact.text.contains("force checkmate") {
        return;
    }
    let us = before.turn();
    let initial = balance(before, us);
    let mut result = None;
    // Prefer the shortest line that demonstrates a stable material payoff.
    for (i, end) in positions.iter().enumerate().skip(2) {
        let gain = balance(end, us) - initial;
        if gain >= 90 && settled(end) {
            let first_gain = exchange::after_move(before, &first.uci)
                .map_or_else(|| balance(&positions[0], us) - initial, |e| e.net);
            if gain > first_gain + 50 || first_gain < 0 {
                let reward = reward(before, end, us);
                result = Some((
                    i,
                    "The payoff",
                    format!("In this line, the follow-up {reward}."),
                ));
                break;
            }
        }
    }
    if result.is_none() {
        for (i, end) in positions.iter().enumerate().skip(2) {
            if end.is_checkmate() && end.turn() != us {
                result = Some((
                    i,
                    "Finish the attack",
                    "The attack ends in checkmate in this line.".into(),
                ));
                break;
            }
            if before.board().queens().count() == 2
                && end.board().queens().is_empty()
                && settled(end)
            {
                let text = if initial >= 180 && balance(end, us) >= initial - 50 {
                    "The queens come off while the material advantage stays intact, making the remaining position easier to convert."
                } else {
                    "The queens come off in this line. Both kings face fewer attacking threats, and the remaining pieces take over."
                };
                result = Some((i, "After the queen trade", text.into()));
                break;
            }
        }
    }
    if result.is_none() && before.fullmoves().get() > 10 {
        // A later castle or new passed pawn is a concrete plan, unlike a generic activity score.
        for (i, end) in positions.iter().enumerate().skip(2) {
            if i % 2 != 0 {
                continue;
            }
            let prior = &positions[i - 1];
            let mut replay = prior.clone();
            let Ok(m) = training::play(&mut replay, &line[i].uci) else {
                continue;
            };
            if m.is_castle() {
                result = Some((
                    i,
                    "Complete development",
                    "The follow-up gets the king castled and brings the rook into play.".into(),
                ));
                break;
            }
            if m.role() == Role::Pawn
                && passed(end, m.to(), us)
                && !passed(prior, m.from().unwrap(), us)
            {
                result = Some((i, "Create a passer", format!("The follow-up creates a passed pawn on {}. The opponent's pieces will have to handle its advance.", m.to())));
                break;
            }
        }
    }
    if let Some((index, title, text)) = result {
        // Keep an existing exchange demonstration unless the longer line explains a new gain.
        if !fact.follow_up.is_empty() && title != "The payoff" {
            return;
        }
        // continuation supports four replies; keep the displayed endpoint identical to the claim.
        if index > 4 {
            return;
        }
        let moves: Vec<_> = line
            .iter()
            .take(index + 1)
            .skip(1)
            .map(|s| s.uci.clone())
            .collect();
        let steps = tactics::continuation(&positions[0], &moves, false);
        if steps.len() == index {
            fact.follow_up.clear();
            fact.outlook = Some(Outlook {
                title: title.into(),
                text,
                steps,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::position;
    fn explain(fen: &str, moves: &[&str]) -> Vec<tactics::Evidence> {
        let p = position(fen).unwrap();
        let line = training::line(&p, &moves.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(line.len(), moves.len());
        let mut facts = tactics::move_facts(&p, moves[0]);
        enrich(&mut facts, &p, &line);
        facts
    }
    #[test]
    fn pawn_move_explains_and_highlights_the_diagonal_it_opens() {
        let facts = explain(&fen(&Chess::default()), &["e2e4"]);
        assert!(facts[0].text.contains("bishop's diagonal"));
        assert!(facts[0].arrows.len() >= 2);
        assert!(facts[0].arrows.iter().all(|a| a.from == "f1"));
    }
    #[test]
    fn a_delayed_fork_payoff_is_replayed_and_summarized_once() {
        let facts = explain(
            "3r3k/6pp/8/4N3/8/8/P7/6K1 w - - 0 12",
            &["e5f7", "h8g8", "f7d8", "g8f8"],
        );
        let outlook = facts[0].outlook.as_ref().unwrap();
        assert_eq!(outlook.steps.len(), 2);
        assert_eq!(outlook.steps.last().unwrap().uci, "f7d8");
        assert!(outlook.text.contains("wins the rook"));
        assert!(!outlook.text.contains("Nxd8"));
    }
    #[test]
    fn a_queen_trade_explains_the_rook_it_wins_after_the_recapture() {
        let facts = explain(
            "3q2nr/5k2/1Q3b2/4Bp1p/3P4/8/PP3PPP/4R1K1 w - - 3 32",
            &["b6d8", "f6d8", "e5h8", "g8e7", "h8e5"],
        );
        let outlook = facts[0].outlook.as_ref().unwrap();
        assert!(outlook.text.contains("wins the rook"));
        assert_eq!(outlook.steps.last().unwrap().uci, "e5h8");
        assert!(facts[0].follow_up.is_empty());
    }
    #[test]
    fn unfinished_exchanges_are_not_described_as_winning_material() {
        let p = position("3r3k/8/8/3Q4/8/8/8/6K1 b - - 0 1").unwrap();
        assert!(!settled(&p));
    }
    #[test]
    fn a_retreat_explains_the_attack_it_escapes() {
        let facts = explain("4k3/8/8/8/3q4/8/3R2K1/8 w - - 0 12", &["d2c2"]);
        assert_eq!(facts[0].theme, "Defense");
        assert!(facts[0].text.contains("queen on d4"));
        assert!(facts[0].squares.contains(&"d4".to_string()));
    }
    #[test]
    fn rook_file_and_passed_pawn_have_specific_plans() {
        let rook = explain("7k/8/8/8/8/8/8/R5K1 w - - 0 12", &["a1d1"]);
        assert!(rook[0].text.contains("open d-file"));
        let pawn = explain("7k/8/8/4P3/8/8/8/6K1 w - - 0 12", &["e5e6"]);
        assert_eq!(pawn[0].theme, "Passed pawns");
        assert!(pawn[0].text.contains("2 squares from promotion"));
    }
    #[test]
    fn an_attack_on_the_queen_takes_priority_over_file_control() {
        let facts = explain("7k/8/8/3q4/8/8/8/R4RK1 w - - 0 12", &["a1d1"]);
        assert!(facts[0].text.contains("attacks the queen"));
        assert!(!facts[0].text.contains("open d-file"));
    }
    #[test]
    fn king_explanation_identifies_the_pawn_it_approaches() {
        let facts = explain("7k/8/8/8/P7/8/8/4K3 w - - 0 30", &["e1d2"]);
        assert!(facts[0].text.contains("its pawn on a4"));
        assert!(facts[0].squares.contains(&"a4".into()));
    }
    #[test]
    fn invalid_cached_line_cannot_generate_a_plan() {
        let p = Chess::default();
        let mut facts = tactics::move_facts(&p, "e2e4");
        let mut line = training::line(&p, &["e2e4".into(), "e7e5".into(), "g1f3".into()]);
        line[2].fen = fen(&p);
        enrich(&mut facts, &p, &line);
        assert!(facts[0].outlook.is_none());
        assert!(facts[0].spoken_text.is_none());
    }
}
