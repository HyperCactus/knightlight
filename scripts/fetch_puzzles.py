"""Build a large offline CC0 puzzle bank. Sources and exact solution lines are retained."""
import argparse, csv, io, json, os, urllib.request
from collections import Counter
from pathlib import Path
import chess, zstandard

parser = argparse.ArgumentParser()
parser.add_argument('--limit', type=int, default=100000)
parser.add_argument('--output', default='data/public-puzzles.json')
args = parser.parse_args()
themes = {'fork':'Forks & double attacks', 'pin':'Pins', 'skewer':'Pins',
          'discoveredAttack':'Forks & double attacks', 'deflection':'Material & captures',
          'attraction':'Material & captures', 'sacrifice':'King safety',
          'backRankMate':'Checkmate patterns', 'mateIn2':'Checkmate patterns',
          'mateIn3':'Checkmate patterns', 'mateIn4':'Checkmate patterns',
          'promotion':'Endgame technique', 'pawnEndgame':'Endgame technique',
          'rookEndgame':'Endgame technique', 'defensiveMove':'King safety',
          'hangingPiece':'Material & captures', 'endgame':'Endgame technique'}
pack, seen = [], set()
counts = Counter()
url='https://database.lichess.org/lichess_db_puzzle.csv.zst'
with urllib.request.urlopen(url, timeout=90) as response:
    with zstandard.ZstdDecompressor().stream_reader(response) as stream:
        for row in csv.DictReader(io.TextIOWrapper(stream)):
            if not 600 <= int(row['Rating']) <= 2500 or int(row['Popularity']) < 85 or int(row['NbPlays']) < 100 or int(row['RatingDeviation']) > 100:
                continue
            tags=row['Themes'].split()
            if 'mateIn1' in tags or 'oneMove' in tags: continue
            key=next((tag for tag in themes if tag in tags), None)
            if key is None: continue
            moves=row['Moves'].split()
            if not 4 <= len(moves) <= 10: continue
            try:
                board=chess.Board(row['FEN'])
                board.push_uci(moves[0])
                identity=' '.join(board.fen().split()[:4])
                if identity in seen or board.legal_moves.count() <= 2: continue
                solution=moves[1:]
                check=board.copy()
                for move in solution: check.push_uci(move)
                # A complete published tactic, not an already lost position or a trivial one-move capture.
                if not check.is_checkmate():
                    values={chess.PAWN:100,chess.KNIGHT:320,chess.BISHOP:330,chess.ROOK:500,chess.QUEEN:900,chess.KING:0}
                    def score(b): return sum(values[p.piece_type]*(1 if p.color==board.turn else -1) for p in b.piece_map().values())
                    if score(check)<score(board)+90 and 'defensiveMove' not in tags: continue
                if counts[themes[key]] >= args.limit//4: continue
                pack.append({'id':row['PuzzleId'],'fen':board.fen(),'moves':solution,'rating':int(row['Rating']),
                    'theme':themes[key],'tags':tags,'game_url':row['GameUrl']})
                seen.add(identity); counts[themes[key]]+=1
            except (ValueError,IndexError): continue
            if len(pack)%10000==0: print(f'{len(pack):,} positions collected',flush=True)
            if len(pack)>=args.limit: break
output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True)
tmp=output.with_suffix('.tmp');tmp.write_text(json.dumps(pack,separators=(',',':'))+'\n');os.replace(tmp,output)
print(f'Saved {len(pack):,} unique, legally replayed positions: {dict(counts)}',flush=True)
