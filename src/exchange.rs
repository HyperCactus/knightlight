//! Legal, local exchanges. This is a material check, not a positional evaluation.
use crate::training;
use shakmaty::{Chess, Move, Position, Role, Square};

pub fn value(role: Role) -> i32 {
    match role {
        Role::Pawn => 100,
        Role::Knight => 320,
        Role::Bishop => 330,
        Role::Rook => 500,
        Role::Queen => 900,
        Role::King => 0,
    }
}
pub fn recaptures(pos: &Chess, target: Square) -> Vec<Move> {
    let mut moves: Vec<_> = pos
        .legal_moves()
        .into_iter()
        .filter(|m| m.is_capture() && m.to() == target)
        .collect();
    moves.sort_by_key(|m| value(m.role()));
    moves
}
fn search(pos: &Chess, target: Square, budget: &mut usize) -> (i32, Vec<String>) {
    if *budget == 0 {
        return (0, vec![]);
    }
    *budget -= 1;
    let mut best = (0, vec![]);
    for m in recaptures(pos, target) {
        let mut next = pos.clone();
        next.play_unchecked(m);
        let (reply, line) = search(&next, target, budget);
        let gain = value(m.capture().unwrap()) + m.promotion().map(|r| value(r) - 100).unwrap_or(0)
            - reply;
        if gain > best.0 || (gain == best.0 && best.1.is_empty()) {
            let mut moves = vec![shakmaty::uci::UciMove::from_standard(m).to_string()];
            moves.extend(line);
            best = (gain, moves);
        }
    }
    best
}
#[derive(Clone)]
pub struct Exchange {
    pub net: i32,
    pub replies: Vec<Move>,
    pub line: Vec<String>,
}
pub fn after_move(before: &Chess, uci: &str) -> Option<Exchange> {
    let mut after = before.clone();
    let m = training::play(&mut after, uci).ok()?;
    if m.is_castle() {
        return None;
    }
    let replies = recaptures(&after, m.to());
    let (cost, line) = search(&after, m.to(), &mut 512);
    Some(Exchange {
        net: m.capture().map(value).unwrap_or(0)
            + m.promotion().map(|r| value(r) - 100).unwrap_or(0)
            - cost,
        replies,
        line,
    })
}
pub fn needs_verification(before: &Chess, uci: &str) -> bool {
    let Some(exchange) = after_move(before, uci) else {
        return false;
    };
    let Some(piece) = uci
        .get(..2)
        .and_then(|s| s.parse().ok())
        .and_then(|s| before.board().piece_at(s))
    else {
        return false;
    };
    !exchange.replies.is_empty() && (piece.role == Role::Queen || exchange.net < -150)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::position;
    #[test]
    fn illegal_king_and_pinned_recaptures_are_not_threats() {
        for fen in [
            "8/8/4k3/3p4/8/8/6B1/3Q2K1 w - - 0 1",
            "4k3/3pr3/2B5/8/8/8/8/3QR1K1 w - - 0 1",
        ] {
            let p = position(fen).unwrap();
            let uci = if fen.starts_with("8/") {
                "d1d5"
            } else {
                "d1d7"
            };
            assert!(after_move(&p, uci).unwrap().replies.is_empty());
        }
        let p = position("8/8/4k3/3p4/8/8/8/3Q2K1 w - - 0 1").unwrap();
        assert!(after_move(&p, "d1d5")
            .unwrap()
            .replies
            .iter()
            .any(|m| m.role() == Role::King));
    }
    #[test]
    fn queen_trade_is_distinct_from_losing_a_queen() {
        let trade =
            position("r1bqkb1r/ppp3pp/4p3/3P4/4QP1P/8/PP4P1/R1B1K1NR b KQkq - 0 13").unwrap();
        let e = after_move(&trade, "d8d5").unwrap();
        assert_eq!(e.net, 100);
        assert_eq!(&e.line[..2], ["e4d5", "e6d5"]);
        let hanging = position("3r3k/8/8/3p4/8/8/8/3Q2K1 w - - 0 1").unwrap();
        assert_eq!(after_move(&hanging, "d1d5").unwrap().net, -800);
        assert!(needs_verification(&hanging, "d1d5"));
    }
}
