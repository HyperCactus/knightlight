use serde::Serialize;
use shakmaty::{Bitboard, Chess, Color, Position};

/// Board control, including defended friendly pieces. This is deliberately
/// independent of whose turn it is: pawn pushes and castling are not attacks.
#[derive(Serialize)]
pub struct ThreatMap {
    pub position: String,
    pub white: Vec<String>,
    pub black: Vec<String>,
}

pub fn threats(pos: &Chess) -> ThreatMap {
    let controlled = |color| {
        pos.board()
            .by_color(color)
            .into_iter()
            .fold(Bitboard::EMPTY, |map, sq| {
                map | pos.board().attacks_from(sq)
            })
            .into_iter()
            .map(|sq| sq.to_string())
            .collect()
    };
    ThreatMap {
        position: crate::fen(pos)
            .split_whitespace()
            .take(4)
            .collect::<Vec<_>>()
            .join(" "),
        white: controlled(Color::White),
        black: controlled(Color::Black),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(fen: &str) -> ThreatMap {
        threats(&crate::position(fen).unwrap())
    }

    #[test]
    fn pawns_control_diagonals_in_both_directions_not_pushes() {
        let m = map("7k/8/8/3p4/4P3/8/8/K7 w - - 0 1");
        assert!(m.white.contains(&"d5".into()));
        assert!(m.white.contains(&"f5".into()));
        assert!(!m.white.contains(&"e5".into()));
        assert!(m.black.contains(&"c4".into()));
        assert!(m.black.contains(&"e4".into()));
        assert!(!m.black.contains(&"d4".into()));
    }

    #[test]
    fn rays_include_the_first_blocker_and_do_not_pass_through_it() {
        let m = map("7k/8/8/3r4/8/8/3P4/K2R4 w - - 0 1");
        assert!(m.white.contains(&"d2".into()));
        assert!(!m.white.contains(&"d3".into()));
        assert!(m.black.contains(&"d2".into()));
        assert!(!m.black.contains(&"d1".into()));
    }

    #[test]
    fn knights_jump_blockers_and_kings_do_not_wrap_at_board_edges() {
        let m = map("7k/8/8/8/8/2PP4/2NP4/K7 w - - 0 1");
        for sq in ["a1", "a3", "b4", "d4", "e3", "e1"] {
            assert!(m.white.contains(&sq.into()), "Missing knight control: {sq}");
        }
        assert_eq!(m.black, ["g7", "h7", "g8"]);
    }

    #[test]
    fn control_is_independent_of_turn_and_move_counters() {
        let a = map("7k/8/8/3p4/4P3/8/8/K7 w - - 0 1");
        let b = map("7k/8/8/3p4/4P3/8/8/K7 b - - 13 25");
        assert_eq!(a.white, b.white);
        assert_eq!(a.black, b.black);
    }
}
