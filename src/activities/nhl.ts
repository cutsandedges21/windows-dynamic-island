// The NHL's 32 teams by division, for the Hockey activity's team choice (a grid of codes,
// one line per division). Plain data in its own file: catalog.ts can't import sports.ts
// (sports.ts imports base.ts, which imports catalog.ts).

const DIVISIONS: Array<[string, Array<[string, string]>]> = [
  ['Atlantic', [['BOS', 'Boston Bruins'], ['BUF', 'Buffalo Sabres'], ['DET', 'Detroit Red Wings'], ['FLA', 'Florida Panthers'], ['MTL', 'Montréal Canadiens'], ['OTT', 'Ottawa Senators'], ['TBL', 'Tampa Bay Lightning'], ['TOR', 'Toronto Maple Leafs']]],
  ['Metropolitan', [['CAR', 'Carolina Hurricanes'], ['CBJ', 'Columbus Blue Jackets'], ['NJD', 'New Jersey Devils'], ['NYI', 'New York Islanders'], ['NYR', 'New York Rangers'], ['PHI', 'Philadelphia Flyers'], ['PIT', 'Pittsburgh Penguins'], ['WSH', 'Washington Capitals']]],
  ['Central', [['CHI', 'Chicago Blackhawks'], ['COL', 'Colorado Avalanche'], ['DAL', 'Dallas Stars'], ['MIN', 'Minnesota Wild'], ['NSH', 'Nashville Predators'], ['STL', 'St. Louis Blues'], ['UTA', 'Utah Mammoth'], ['WPG', 'Winnipeg Jets']]],
  ['Pacific', [['ANA', 'Anaheim Ducks'], ['CGY', 'Calgary Flames'], ['EDM', 'Edmonton Oilers'], ['LAK', 'Los Angeles Kings'], ['SJS', 'San Jose Sharks'], ['SEA', 'Seattle Kraken'], ['VAN', 'Vancouver Canucks'], ['VGK', 'Vegas Golden Knights']]],
];

export const TEAMS: Array<{ value: string; label: string; group: string }> = DIVISIONS.flatMap(([group, teams]) => teams.map(([value, label]) => ({ value, label, group })));
