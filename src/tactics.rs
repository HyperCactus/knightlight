//! Board facts for teaching. Geometry describes attacks; engine lines support consequences.
use crate::{fen, position, training};
use serde::{Deserialize, Serialize};
use shakmaty::{Bitboard, Chess, Position, Role, Square};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Arrow {
    pub from: String,
    pub to: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceContext {
    Played,
    OpponentReply,
    Alternative,
    Suggestion,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContinuationStep {
    pub title: String,
    pub text: String,
    pub before: String,
    pub fen: String,
    pub uci: String,
    pub squares: Vec<String>,
    pub arrows: Vec<Arrow>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evidence {
    pub title: String,
    pub text: String,
    pub theme: String,
    pub fen: String,
    pub squares: Vec<String>,
    pub arrows: Vec<Arrow>,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub uci: Option<String>,
    #[serde(default)]
    pub context: Option<EvidenceContext>,
    #[serde(default)]
    pub introduction: String,
    #[serde(default)]
    pub spoken_text: Option<String>,
    #[serde(default)]
    pub follow_up: Vec<ContinuationStep>,
    #[serde(default)]
    pub outlook: Option<crate::strategy::Outlook>,
}
pub(crate) fn continuation(
    after: &Chess,
    moves: &[String],
    conditional: bool,
) -> Vec<ContinuationStep> {
    continuation_up_to(after, moves, conditional, 4)
}
fn continuation_up_to(
    after: &Chess,
    moves: &[String],
    conditional: bool,
    limit: usize,
) -> Vec<ContinuationStep> {
    let mut pos = after.clone();
    let mut steps = vec![];
    for (i, uci) in moves.iter().take(limit.min(8)).enumerate() {
        let before = fen(&pos);
        let action = move_action(&pos, uci);
        let Ok(m) = training::play(&mut pos, uci) else {
            break;
        };
        let from = m.from().unwrap().to_string();
        let to = if m.is_castle() {
            pos.board().king_of(!pos.turn()).unwrap()
        } else {
            m.to()
        }
        .to_string();
        let text = if pos.is_checkmate() {
            format!(
                "Then {} delivers checkmate. The king has no escape.",
                training::san(&position(&before).unwrap(), uci)
            )
        } else {
            format!(
                "{}{} can {action}.",
                if i == 0 { "" } else { "Then " },
                if !pos.turn() == shakmaty::Color::White {
                    "White"
                } else {
                    "Black"
                }
            )
        };
        let mut squares = vec![from.clone(), to.clone()];
        let mut arrows = vec![Arrow {
            from: from.clone(),
            to: to.clone(),
            kind: "move".into(),
        }];
        if pos.is_check() {
            let king = pos.board().king_of(pos.turn()).unwrap();
            squares.push(king.to_string());
            for source in pos
                .board()
                .attacks_to(king, !pos.turn(), pos.board().occupied())
            {
                squares.push(source.to_string());
                arrows.push(arrow(source, king, "check"));
            }
        }
        steps.push(ContinuationStep {
            title: if conditional {
                "Possible exchange"
            } else {
                "Engine continuation"
            }
            .into(),
            text,
            before,
            fen: fen(&pos),
            uci: uci.clone(),
            squares,
            arrows,
        });
    }
    steps
}
fn move_action(before: &Chess, uci: &str) -> String {
    let mut after = before.clone();
    let Ok(m) = training::play(&mut after, uci) else {
        return "consider this continuation".into();
    };
    if m.is_castle() {
        return format!(
            "castle {}",
            if after.board().king_of(before.turn()).unwrap().file() == shakmaty::File::G {
                "kingside"
            } else {
                "queenside"
            }
        );
    }
    if let Some(role) = m.promotion() {
        return format!("promote the pawn to a {} on {}", name(role), m.to());
    }
    if let Some(victim) = m.capture() {
        return format!(
            "capture the {} on {} with the {}{}",
            name(victim),
            m.to(),
            name(m.role()),
            if m.is_en_passant() { " en passant" } else { "" }
        );
    }
    format!("move the {} to {}", name(m.role()), m.to())
}
pub fn name(r: Role) -> &'static str {
    match r {
        Role::Pawn => "pawn",
        Role::Knight => "knight",
        Role::Bishop => "bishop",
        Role::Rook => "rook",
        Role::Queen => "queen",
        Role::King => "king",
    }
}
fn arrow(a: Square, b: Square, kind: &str) -> Arrow {
    Arrow {
        from: a.to_string(),
        to: b.to_string(),
        kind: kind.into(),
    }
}
// Capturing a geometrically attacked target must not expose our own king.
// Keep this separate from Assist's geometric square-control overlay.
fn actionable_targets(pos: &Chess, from: Square, us: shakmaty::Color) -> Bitboard {
    let board = pos.board();
    let king = board.king_of(us).unwrap();
    let occupied = board.occupied() & !Bitboard::from_square(from);
    (board.attacks_from(from) & board.by_color(!us))
        .into_iter()
        .filter(|target| {
            (board.attacks_to(king, !us, occupied) & !Bitboard::from_square(*target)).is_empty()
        })
        .collect()
}
pub fn move_facts(before: &Chess, uci: &str) -> Vec<Evidence> {
    let mut after = before.clone();
    let Ok(m) = training::play(&mut after, uci) else {
        return vec![];
    };
    let b = after.board();
    let us = before.turn();
    let enemy = !us;
    // Shakmaty encodes castling's destination as the rook's original square.
    let to = if m.is_castle() {
        b.king_of(us).unwrap()
    } else {
        m.to()
    };
    let mut facts = vec![];
    let mut add =
        |title: &str, text: String, theme: &str, squares: Vec<String>, arrows: Vec<Arrow>| {
            let mut squares = squares;
            for a in &arrows {
                for square in [&a.from, &a.to] {
                    if !squares.contains(square) {
                        squares.push(square.clone());
                    }
                }
            }
            facts.push(Evidence {
                title: title.into(),
                text,
                theme: theme.into(),
                fen: fen(&after),
                squares,
                arrows,
                before: Some(fen(before)),
                uci: Some(uci.into()),
                context: Some(EvidenceContext::Suggestion),
                introduction: format!("One option here is to {}.", move_action(before, uci)),
                spoken_text: None,
                follow_up: vec![],
                outlook: None,
            });
        };
    if after.is_checkmate() {
        let king = b.king_of(enemy).unwrap();
        add(
            "Checkmate",
            format!(
                "{} delivers checkmate: the king on {king} has no way out of check.",
                training::san(before, uci)
            ),
            "Checkmate patterns",
            vec![king.to_string(), to.to_string()],
            b.attacks_to(king, us, b.occupied())
                .into_iter()
                .map(|s| arrow(s, king, "check"))
                .collect(),
        );
    } else {
        if before.is_check() && m.role() != Role::King && !m.is_capture() {
            let king = b.king_of(us).unwrap();
            if let Some(checker) = before
                .board()
                .attacks_to(king, enemy, before.board().occupied())
                .first()
            {
                add(
                    "Block the check",
                    format!(
                        "The {} on {to} blocks the {}'s check, protecting the king on {king}.",
                        name(m.role()),
                        name(before.board().role_at(checker).unwrap())
                    ),
                    "King safety",
                    vec![to.to_string(), king.to_string(), checker.to_string()],
                    vec![arrow(checker, king, "pin")],
                );
            }
        }
        // Tactical threats must survive moving the attacking piece off its square.
        // Assist deliberately keeps geometric control, including pinned pieces.
        let targets: Vec<_> = actionable_targets(&after, to, us)
            .into_iter()
            .filter(|s| b.role_at(*s) != Some(Role::Pawn))
            .collect();
        if targets.len() >= 2 && m.role() != Role::King {
            let list = targets
                .iter()
                .map(|s| format!("{} on {s}", name(b.role_at(*s).unwrap())))
                .collect::<Vec<_>>()
                .join(" and ");
            add(
                "Double attack",
                format!(
                    "The {} on {to} attacks the {list}.",
                    name(b.role_at(to).unwrap())
                ),
                "Forks & double attacks",
                targets.iter().map(ToString::to_string).collect(),
                targets.iter().map(|s| arrow(to, *s, "pressure")).collect(),
            );
        }
        if m.is_capture() {
            let recaptures = crate::exchange::recaptures(&after, to);
            let defended = !recaptures.is_empty();
            add(
                if defended {
                    "Check the recapture"
                } else {
                    "No recapture"
                },
                format!(
                    "{} captures a {} on {to}. {}",
                    training::san(before, uci),
                    name(m.capture().unwrap()),
                    if defended {
                        "The piece can be recaptured."
                    } else {
                        "No opposing piece can recapture."
                    }
                ),
                "Material & captures",
                vec![to.to_string()],
                recaptures
                    .iter()
                    .map(|m| arrow(m.from().unwrap(), to, "capture"))
                    .collect(),
            );
        }
        if after.is_check() {
            let king = b.king_of(enemy).unwrap();
            let checkers = b.attacks_to(king, us, b.occupied());
            add("A forcing check",format!("The king on {king} is in check. The side in check must capture the checking piece, block the check, or move the king."),"King safety",vec![king.to_string()],checkers.into_iter().map(|s|arrow(s,king,"check")).collect());
        }
        // Absolute pins: first enemy piece on a ray, then its king behind it.
        if matches!(m.role(), Role::Bishop | Role::Rook | Role::Queen) {
            if let Some(king) = b.king_of(enemy) {
                for target in (b.attacks_from(to) & b.by_color(enemy)).into_iter() {
                    if target == king {
                        continue;
                    }
                    let dx = king.file() as i32 - to.file() as i32;
                    let dy = king.rank() as i32 - to.rank() as i32;
                    let tx = target.file() as i32 - to.file() as i32;
                    let ty = target.rank() as i32 - to.rank() as i32;
                    if dx * ty != dy * tx || dx * tx + dy * ty <= 0 {
                        continue;
                    }
                    let sx = dx.signum();
                    let sy = dy.signum();
                    let mut x = target.file() as i32 + sx;
                    let mut y = target.rank() as i32 + sy;
                    let mut clear = true;
                    while (0..8).contains(&x) && (0..8).contains(&y) {
                        let sq = Square::new((y * 8 + x) as u32);
                        if sq == king {
                            break;
                        }
                        if b.piece_at(sq).is_some() {
                            clear = false;
                            break;
                        }
                        x += sx;
                        y += sy;
                    }
                    if clear {
                        add("Pinned to the king",format!("The {} on {target} stands between the attacking {} on {to} and its king on {king}. Moving it off this line would expose check.",name(b.role_at(target).unwrap()),name(m.role())),"Pins",vec![target.to_string(),king.to_string()],vec![arrow(to,king,"pin")]);
                    }
                }
            }
        }
    }
    if m.is_castle() {
        add(
            "King to safety",
            "Castling moves the king away from the center and brings a rook closer to the action."
                .into(),
            "King safety",
            vec![
                to.to_string(),
                format!(
                    "{}{}",
                    if to.file() == shakmaty::File::G {
                        "f"
                    } else {
                        "d"
                    },
                    to.rank()
                ),
            ],
            vec![],
        );
    }
    drop(add);
    if facts.is_empty() {
        let actor = name(m.role());
        let color = if us == shakmaty::Color::White {
            "White"
        } else {
            "Black"
        };
        let from = m.from().unwrap_or(to);
        let before_targets = before.board().attacks_from(from);
        let new_targets = if m.role() == Role::King {
            shakmaty::Bitboard::EMPTY
        } else {
            actionable_targets(&after, to, us) & !before_targets
        };
        let center = [Square::D4, Square::E4, Square::D5, Square::E5]
            .into_iter()
            .collect::<shakmaty::Bitboard>();
        let central = |p: &Chess, s: Square| (p.board().attacks_from(s) & center).count();
        let mut arrows = vec![];
        let text = if m.is_promotion() {
            format!(
                "The pawn reaches {to} and promotes to a {}.",
                name(m.promotion().unwrap())
            )
        } else if !new_targets.is_empty() {
            arrows = new_targets
                .into_iter()
                .map(|s| arrow(to, s, "pressure"))
                .collect();
            let targets = new_targets
                .into_iter()
                .map(|s| format!("the {} on {s}", name(b.role_at(s).unwrap())))
                .collect::<Vec<_>>()
                .join(" and ");
            format!("From {to}, the {actor} now attacks {}.", targets)
        } else if central(&after, to) > central(before, from) {
            let controlled = if m.role() == Role::Pawn {
                b.attacks_from(to)
            } else {
                b.attacks_from(to) & center
            };
            arrows = controlled
                .into_iter()
                .map(|s| arrow(to, s, "control"))
                .collect();
            let targets = controlled
                .into_iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .join(" and ");
            format!(
                "The {actor} on {to} controls {targets}, increasing its influence over the central squares."
            )
        } else if m.role() == Role::Pawn
            && matches!(to.file(), shakmaty::File::D | shakmaty::File::E)
        {
            arrows = b
                .attacks_from(to)
                .into_iter()
                .map(|s| arrow(to, s, "control"))
                .collect();
            let targets = b
                .attacks_from(to)
                .into_iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
                .join(" and ");
            format!(
                "{color} advances the central pawn to {to}. Its diagonal reach covers {targets}."
            )
        } else if matches!(m.role(), Role::Knight | Role::Bishop)
            && (from.rank() == shakmaty::Rank::First || from.rank() == shakmaty::Rank::Eighth)
            && before.fullmoves().get() < 11
        {
            format!("{color} develops the {actor} from its starting square to {to}.")
        } else if m.role() == Role::King && b.occupied().count() <= 12 {
            format!("The king moves from {from} to {to}.")
        } else {
            format!("{color} repositions the {actor} from {from} to {to}.")
        };
        facts.push(Evidence {
            title: "Piece activity".into(),
            text,
            theme: if b.occupied().count() <= 12 {
                "Endgame technique"
            } else {
                "Piece activity"
            }
            .into(),
            fen: fen(&after),
            squares: std::iter::once(to.to_string())
                .chain(arrows.iter().map(|a| a.to.clone()))
                .collect(),
            arrows,
            before: Some(fen(before)),
            uci: Some(uci.into()),
            context: Some(EvidenceContext::Suggestion),
            introduction: format!("One option here is to {}.", move_action(before, uci)),
            spoken_text: None,
            follow_up: vec![],
            outlook: None,
        });
    }
    if let Some(exchange) = crate::exchange::after_move(before, uci) {
        let relevant = !after.is_checkmate()
            && (m.is_capture()
                || (!exchange.replies.is_empty()
                    && (m.role() == Role::Queen || exchange.net < -150)));
        if relevant {
            let index = facts
                .iter()
                .position(|f| f.theme == "Material & captures")
                .unwrap_or(0);
            let fact = &mut facts[index];
            if exchange.replies.is_empty() {
                let geometric = b.attacks_to(to, enemy, b.occupied());
                if !geometric.is_empty() {
                    let king = geometric
                        .into_iter()
                        .any(|s| b.role_at(s) == Some(Role::King));
                    fact.spoken_text = Some(if king {
                        format!("The king cannot capture the {} on {to} because that would leave it in check.", name(m.role()))
                    } else {
                        "That piece cannot recapture without leaving its king in check.".into()
                    });
                    fact.arrows = b
                        .attacks_to(to, us, b.occupied())
                        .into_iter()
                        .map(|s| arrow(s, to, "support"))
                        .collect();
                    fact.squares.extend(
                        fact.arrows
                            .iter()
                            .flat_map(|a| [a.from.clone(), a.to.clone()]),
                    );
                } else {
                    fact.spoken_text = Some(format!(
                        "This wins {} {}.",
                        if m.capture() == Some(Role::Pawn) {
                            "a"
                        } else {
                            "the"
                        },
                        name(m.capture().unwrap_or(m.role()))
                    ));
                }
            } else {
                fact.follow_up = continuation(&after, &exchange.line, true);
                let queen_trade = m.role() == Role::Queen && exchange.line.len() >= 2 && {
                    let mut p = after.clone();
                    training::play(&mut p, &exchange.line[0]).is_ok_and(|r| r.role() == Role::Queen)
                        && training::play(&mut p, &exchange.line[1])
                            .is_ok_and(|r| r.capture() == Some(Role::Queen))
                };
                fact.spoken_text = Some(if queen_trade {
                    fact.title = "Follow the queen trade".into();
                    if exchange.line.len() == 2
                        && exchange.net == 100
                        && m.capture() == Some(Role::Pawn)
                    {
                        if let Some(last) = fact.follow_up.last_mut() {
                            last.text.push_str(" Both queens have been exchanged, and the first capture gained a pawn.");
                        }
                    }
                    "This allows a queen exchange.".into()
                } else if exchange.net < -150 {
                    "This gives up material in the exchange.".into()
                } else {
                    if exchange.net >= 90 {
                        format!(
                            "The exchange gains {}.",
                            if exchange.net == 100 {
                                "a pawn"
                            } else {
                                "material"
                            }
                        )
                    } else if exchange.net >= -50 {
                        "The recapture keeps the material balance unchanged.".into()
                    } else {
                        "This gives up material in the exchange.".into()
                    }
                });
            }
            // The exact same checked claim drives both the card and the voice.
            if let Some(text) = &fact.spoken_text {
                fact.text = text.clone();
            }
            if index != 0 {
                let fact = facts.remove(index);
                facts.insert(0, fact);
            }
        }
    }
    facts.truncate(3);
    facts
}
fn add_engine_continuation(
    facts: &mut [Evidence],
    before: &Chess,
    uci: &str,
    line: &[training::LineMove],
    mate: Option<i32>,
) {
    if let Some(exchange) = crate::exchange::after_move(before, uci) {
        if exchange.net < -150 && line.len() > 1 {
            let after_best = position(&line[0].fen).ok();
            // Engine outcome is independent of how many teaching frames we display.
            let forced_mate = mate.is_some_and(|n| n > 0);
            if let (Some(fact), Some(after_best)) = (facts.first_mut(), after_best) {
                fact.follow_up = continuation_up_to(
                    &after_best,
                    &line
                        .iter()
                        .skip(1)
                        .map(|s| s.uci.clone())
                        .collect::<Vec<_>>(),
                    false,
                    if forced_mate { 8 } else { 4 },
                );
                let text = if forced_mate {
                    "This sacrifices material to force checkmate."
                } else {
                    "This continuation gives up material."
                };
                fact.spoken_text = Some(text.into());
                fact.text = text.into();
            }
        }
    }
}
pub fn suggestion_facts(before: &Chess, evaluation: &crate::engine::Evaluation) -> Vec<Evidence> {
    let Some(uci) = evaluation.pv.first() else {
        return vec![];
    };
    let mut facts = move_facts(before, uci);
    add_engine_continuation(
        &mut facts,
        before,
        uci,
        &training::line_up_to(
            before,
            &evaluation.pv,
            if evaluation.mate.is_some_and(|n| n > 0) {
                10
            } else {
                6
            },
        ),
        evaluation.mate,
    );
    crate::strategy::enrich(&mut facts, before, &training::line(before, &evaluation.pv));
    facts
}
pub fn for_review(m: &training::ReviewMove) -> Vec<Evidence> {
    let Ok(before) = position(&m.before) else {
        return vec![];
    };
    let mut facts = vec![];
    if m.loss > 80 {
        if let (Ok(after), Some(reply)) = (position(&m.after), m.reply_line.first()) {
            facts = move_facts(&after, &reply.uci);
            add_engine_continuation(&mut facts, &after, &reply.uci, &m.reply_line, m.mate);
            crate::strategy::enrich(&mut facts, &after, &m.reply_line);
            for f in &mut facts {
                f.title = format!("Opponent's idea · {}", f.title);
                f.context = Some(EvidenceContext::OpponentReply);
                f.introduction = format!(
                    "Now {} can {}.",
                    if m.player { "your opponent" } else { "you" },
                    move_action(&after, &reply.uci)
                );
            }
        }
    }
    // A sound move deserves an explanation of what was actually played.
    // Keep the engine alternative available on demand, without implying it was necessary.
    if m.loss <= 80 && m.best != m.uci {
        let mut played = move_facts(&before, &m.uci);
        let mut actual_line = vec![training::LineMove {
            uci: m.uci.clone(),
            san: m.san.clone(),
            fen: m.after.clone(),
        }];
        actual_line.extend(
            m.reply_line
                .iter()
                .take(if m.mate.is_some_and(|n| n < 0) { 9 } else { 5 })
                .cloned(),
        );
        add_engine_continuation(
            &mut played,
            &before,
            &m.uci,
            &actual_line,
            m.mate.map(|n| -n),
        );
        crate::strategy::enrich(&mut played, &before, &actual_line);
        for f in &mut played {
            f.context = Some(EvidenceContext::Played);
            f.introduction.clear();
            f.title = format!("Played idea · {}", f.title);
        }
        facts.extend(played.into_iter().take(2));
    }
    let mut best = move_facts(&before, &m.best);
    add_engine_continuation(&mut best, &before, &m.best, &m.best_line, m.best_mate);
    crate::strategy::enrich(&mut best, &before, &m.best_line);
    for f in &mut best {
        f.context = Some(if m.best == m.uci {
            EvidenceContext::Played
        } else {
            EvidenceContext::Alternative
        });
        f.introduction = if m.best == m.uci {
            String::new()
        } else {
            let lead = if !m.player {
                "Your opponent could instead have chosen to"
            } else if m.loss > 80 {
                "A better option would have been to"
            } else {
                "Another option was to"
            };
            format!("{lead} {}.", move_action(&before, &m.best))
        };
        f.title = format!(
            "{} · {}",
            if m.best == m.uci {
                "Your idea"
            } else {
                "Better plan"
            },
            f.title
        );
    }
    facts.extend(best);
    facts.truncate(4);
    facts
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_mating_capture_keeps_the_checkmate_explanation() {
        let mut p = Chess::default();
        for u in ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6"] {
            training::play(&mut p, u).unwrap();
        }
        let facts = move_facts(&p, "h5f7");
        assert_eq!(facts[0].title, "Checkmate");
        assert!(facts[0].text.contains("delivers checkmate"));
        assert!(facts[0].spoken_text.is_none());
    }
    #[test]
    fn protected_king_capture_warning_is_replaced_with_defending_diagram() {
        let p = position("8/8/4k3/3p4/8/8/6B1/3Q2K1 w - - 0 1").unwrap();
        let facts = move_facts(&p, "d1d5");
        let fact = facts
            .iter()
            .find(|f| f.theme == "Material & captures")
            .unwrap();
        assert!(fact.text.contains("cannot capture"));
        assert!(!fact.arrows.iter().any(|a| a.from == "e6"));
        assert!(fact
            .arrows
            .iter()
            .any(|a| a.from == "g2" && a.to == "d5" && a.kind == "support"));
    }
    #[test]
    fn defended_queen_capture_explains_the_whole_trade() {
        let p = position("r1bqkb1r/ppp3pp/4p3/3P4/4QP1P/8/PP4P1/R1B1K1NR b KQkq - 0 13").unwrap();
        let facts = move_facts(&p, "d8d5");
        assert!(facts[0].text.contains("queen exchange"));
        assert_eq!(facts[0].follow_up.len(), 2);
        let mut replay = position(&facts[0].fen).unwrap();
        for step in &facts[0].follow_up {
            assert_eq!(fen(&replay), step.before);
            training::play(&mut replay, &step.uci).unwrap();
            assert_eq!(fen(&replay), step.fen);
        }
    }
    #[test]
    fn a_king_does_not_threaten_to_take_a_protected_piece() {
        let p = position("7k/8/8/8/5p2/4n3/8/6K1 w - - 0 1").unwrap();
        let facts = move_facts(&p, "g1f2");
        assert!(!facts.iter().any(|f| f.text.contains("attacks the knight")));
    }
    #[test]
    fn a_real_queen_sacrifice_shows_the_forcing_mate_instead_of_a_false_material_warning() {
        let p = position("5r1k/6pp/4Q2N/8/8/8/8/6K1 w - - 0 1").unwrap();
        let mut engine = crate::engine::Engine::new().unwrap();
        let a = training::eval(&mut engine, &p, 10).unwrap();
        assert_eq!(a.pv[0], "e6g8");
        assert_eq!(a.mate, Some(2));
        let mut after = p.clone();
        training::play(&mut after, "e6g8").unwrap();
        let b = training::eval(&mut engine, &after, 10).unwrap();
        let m = training::describe(&p, "e6g8", &a, &b, 0, true);
        let fact = m
            .evidence
            .iter()
            .find(|f| f.text.contains("force checkmate"))
            .unwrap();
        assert_eq!(fact.follow_up.last().unwrap().uci, "h6f7");
        assert!(fact.follow_up.last().unwrap().text.contains("checkmate"));
    }
    #[test]
    fn review_introduces_possible_replies_and_alternatives_with_correct_perspective() {
        let mut p = Chess::default();
        training::play(&mut p, "f2f3").unwrap();
        training::play(&mut p, "e7e5").unwrap();
        let a = crate::engine::Evaluation {
            score: 0,
            mate: None,
            pv: vec!["g2g3".into()],
        };
        let b = crate::engine::Evaluation {
            score: 500,
            mate: Some(1),
            pv: vec!["d8h4".into()],
        };
        let m = training::describe(&p, "g2g4", &a, &b, 2, true);
        let reply = m
            .evidence
            .iter()
            .find(|f| matches!(f.context, Some(EvidenceContext::OpponentReply)))
            .unwrap();
        let alternative = m
            .evidence
            .iter()
            .find(|f| matches!(f.context, Some(EvidenceContext::Alternative)))
            .unwrap();
        assert_eq!(
            reply.introduction,
            "Now your opponent can move the queen to h4."
        );
        assert_eq!(
            alternative.introduction,
            "A better option would have been to move the pawn to g3."
        );
        assert!(m.explanation.contains(&reply.introduction));
        assert!(m.explanation.contains(&alternative.introduction));
        let other = training::describe(&p, "g2g4", &a, &b, 2, false);
        assert!(other
            .explanation
            .contains("Now you can move the queen to h4."));
        assert!(other
            .explanation
            .contains("Your opponent could instead have chosen to move the pawn to g3."));
    }
    #[test]
    fn quiet_alternatives_are_not_called_mistakes_and_hints_are_conditional() {
        let p = Chess::default();
        let a = crate::engine::Evaluation {
            score: 0,
            mate: None,
            pv: vec!["e2e4".into()],
        };
        let b = crate::engine::Evaluation {
            score: 20,
            mate: None,
            pv: vec!["e7e5".into()],
        };
        let m = training::describe(&p, "d2d4", &a, &b, 0, true);
        assert!(m
            .evidence
            .iter()
            .any(|f| f.introduction == "Another option was to move the pawn to e4."));
        assert!(!m.explanation.contains("A better option"));
        let hint = move_facts(&p, "g1f3");
        assert_eq!(
            hint[0].introduction,
            "One option here is to move the knight to f3."
        );
        assert!(matches!(hint[0].context, Some(EvidenceContext::Suggestion)));
    }
    #[test]
    fn quiet_move_has_concrete_facts_and_replay_origin() {
        let p = Chess::default();
        let facts = move_facts(&p, "g1f3");
        assert!(facts.iter().any(|f| f.text.contains("central squares")));
        let fact = &facts[0];
        assert_eq!(fact.before.as_deref(), Some(fen(&p).as_str()));
        assert_eq!(fact.uci.as_deref(), Some("g1f3"));
        let mut replay = position(fact.before.as_deref().unwrap()).unwrap();
        training::play(&mut replay, fact.uci.as_deref().unwrap()).unwrap();
        assert_eq!(fen(&replay), fact.fen);
        assert!(!fact.text.contains("positional choice"));
    }
    #[test]
    fn pawn_control_marks_both_diagonals_including_empty_squares() {
        let facts = move_facts(&Chess::default(), "e2e4");
        let fact = &facts[0];
        assert_eq!(fact.arrows.len(), 2);
        for target in ["d5", "f5"] {
            assert!(fact.squares.contains(&target.to_string()));
            assert!(fact
                .arrows
                .iter()
                .any(|a| a.from == "e4" && a.to == target && a.kind == "control"));
        }
        assert!(fact.squares.contains(&"e4".into()));
    }
    #[test]
    fn newly_attacked_piece_is_connected_to_the_attacker() {
        let p = position("7k/8/8/3n4/8/4P3/8/7K w - - 0 1").unwrap();
        let fact = &move_facts(&p, "e3e4")[0];
        assert!(fact.text.contains("knight on d5"));
        assert!(fact.squares.contains(&"d5".into()));
        assert!(fact
            .arrows
            .iter()
            .any(|a| a.from == "e4" && a.to == "d5" && a.kind == "pressure"));
    }
    #[test]
    fn castling_marks_the_king_and_rook_destinations() {
        for (uci, king, rook) in [("e1g1", "g1", "f1"), ("e1c1", "c1", "d1")] {
            let p = position("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1").unwrap();
            let facts = move_facts(&p, uci);
            let fact = facts.iter().find(|f| f.title == "King to safety").unwrap();
            assert!(fact.squares.contains(&king.into()));
            assert!(fact.squares.contains(&rook.into()));
            assert!(!fact.squares.contains(&"h1".into()));
            assert!(!fact.squares.contains(&"a1".into()));
        }
    }
    #[test]
    fn recapture_cues_show_real_defenders_and_all_arrow_endpoints() {
        let p = position("8/7k/1p6/r7/8/8/8/Q6K w - - 0 1").unwrap();
        let facts = move_facts(&p, "a1a5");
        let capture = facts
            .iter()
            .find(|f| f.title == "Check the recapture")
            .unwrap();
        assert!(capture
            .arrows
            .iter()
            .any(|a| a.from == "b6" && a.to == "a5"));
        for fact in facts {
            let after = position(&fact.fen).unwrap();
            for a in fact.arrows {
                assert!(fact.squares.contains(&a.from));
                assert!(fact.squares.contains(&a.to));
                assert!(after
                    .board()
                    .attacks_from(a.from.parse().unwrap())
                    .contains(a.to.parse().unwrap()));
            }
        }
    }
    #[test]
    fn fork_has_concrete_targets() {
        let p = position("8/8/2r3k1/8/8/3N4/8/4K3 w - - 0 1").unwrap();
        let f = move_facts(&p, "d3e5");
        let fork = f
            .iter()
            .find(|x| x.theme == "Forks & double attacks")
            .unwrap();
        assert!(fork.squares.contains(&"c6".into()));
        assert!(fork.squares.contains(&"g6".into()));
        assert_eq!(fork.arrows.len(), 2);
    }
    #[test]
    fn pin_and_capture_do_not_claim_free_material() {
        let p = position("4k3/4n3/8/8/8/8/8/R5K1 w - - 0 1").unwrap();
        let f = move_facts(&p, "a1e1");
        assert!(f.iter().any(|x| x.theme == "Pins"));
        let p = position("8/7k/1p6/r7/8/8/8/Q6K w - - 0 1").unwrap();
        assert!(move_facts(&p, "a1a5")
            .iter()
            .any(|x| x.text.contains("recapture") || x.text.contains("exchange")));
    }
    #[test]
    fn a_pinned_blocking_knight_is_not_taught_as_a_fork() {
        let before = position("7k/8/7b/8/8/1r1p1q2/8/1NK5 w - - 0 1").unwrap();
        let facts = move_facts(&before, "b1d2");
        assert!(!facts.iter().any(|f| f.theme == "Forks & double attacks"));
        assert!(facts
            .iter()
            .any(|f| f.text.contains("blocks") && f.text.contains("check")));
    }

    #[test]
    fn a_mate_in_four_sacrifice_explains_and_shows_the_payoff() {
        let before = position("5Q1R/5p1p/1b3qp1/p6k/P2P4/8/1P2rPPP/5RK1 b - - 8 32").unwrap();
        let evaluation = crate::engine::Evaluation {
            score: 9996,
            mate: Some(4),
            pv: ["f6f2", "f1f2", "e2e1", "f2f1", "b6d4", "g1h1", "e1f1"]
                .map(str::to_string)
                .to_vec(),
        };
        let facts = suggestion_facts(&before, &evaluation);
        assert!(facts[0].text.contains("force checkmate"));
        let last = facts[0].follow_up.last().expect("mating demonstration");
        assert!(position(&last.fen).unwrap().is_checkmate());
        assert!(last.text.contains("checkmate"));
    }
}
