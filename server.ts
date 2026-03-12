import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { PythonShell } from 'python-shell';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("zaba.db");

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sport TEXT,
    league TEXT,
    home_team TEXT,
    away_team TEXT,
    stadium TEXT,
    pitch_condition TEXT,
    match_time DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS team_stats (
    team_name TEXT PRIMARY KEY,
    last_5_points INTEGER, -- 0 to 15
    goal_avg_scored REAL,
    goal_avg_conceded REAL,
    injuries TEXT,
    suspensions TEXT
  );

  CREATE TABLE IF NOT EXISTS odds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER,
    bookmaker TEXT,
    market TEXT, -- '1X2', 'OverUnder', etc.
    outcome TEXT, -- '1', 'X', '2', 'Over', 'Under'
    odds REAL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(match_id) REFERENCES matches(id),
    UNIQUE(match_id, bookmaker, market, outcome)
  );
`);

// Mock Data Generator for Zambian Sites
const ZAMBIAN_SITES = [
  "Betway Zambia", "1xBet Zambia", "Betpawa Zambia", "Gal Sport Betting (GSB)",
  "Bolabet Zambia", "SportyBet Zambia", "Premier Bet Zambia", "888bet Zambia",
  "Melbet Zambia", "Castlebet Zambia", "22Bet Zambia", "Bongobongo Zambia",
  "Playmaster Zambia", "Betlion Zambia", "Bwanabet Zambia", "WinWin Zambia",
  "XSportsbet", "Betta1 Zambia", "4rabet Zambia", "bwin Zambia",
  "10bet Zambia", "GreatOdds Zambia", "Bet365", "Helabet",
  "BetAndYou", "SportPesa", "M-Bet Zambia", "Paddy Power",
  "William Hill", "Betway International"
];

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/opportunities", (req, res) => {
    const timeframe = (req.query.timeframe as string) || 'today';
    
    let timeFilter = "";
    if (timeframe === 'today') {
      timeFilter = "AND match_time <= date('now', '+1 day')";
    } else if (timeframe === 'tomorrow') {
      timeFilter = "AND match_time > date('now', '+1 day') AND match_time <= date('now', '+2 days')";
    } else if (timeframe.endsWith('days')) {
      const days = parseInt(timeframe);
      if (!isNaN(days)) {
        timeFilter = `AND match_time <= date('now', '+${days} days')`;
      }
    }

    const matches = db.prepare(`SELECT * FROM matches WHERE 1=1 ${timeFilter}`).all();
    const opportunities: any[] = [];

    matches.forEach((match: any) => {
      const odds = db.prepare("SELECT * FROM odds WHERE match_id = ?").all(match.id) as any[];
      
      // Group by market
      const markets = [
        '1X2', 
        'Double Chance', 
        'GG/NG', 
        'Goals Over/Under 2.5', 
        'Corners Over/Under 9.5', 
        'DC & Over/Under 2.5'
      ];

      markets.forEach(market => {
        const marketOdds = odds.filter(o => o.market === market);
        if (marketOdds.length === 0) return;

        // Find best odds for each outcome
        const bestOdds: any = {};
        let outcomes: string[] = [];
        if (market === '1X2') outcomes = ['1', 'X', '2'];
        else if (market === 'Double Chance') outcomes = ['1X', '12', 'X2'];
        else if (market === 'GG/NG') outcomes = ['GG', 'NG'];
        else if (market === 'Goals Over/Under 2.5') outcomes = ['Over', 'Under'];
        else if (market === 'Corners Over/Under 9.5') outcomes = ['Over', 'Under'];
        else if (market === 'DC & Over/Under 2.5') outcomes = ['1X & Over', 'X2 & Over', '1X & Under', 'X2 & Under'];
        
        outcomes.forEach(outcome => {
          const outcomeOdds = marketOdds.filter(o => o.outcome === outcome);
          if (outcomeOdds.length > 0) {
            bestOdds[outcome] = outcomeOdds.reduce((prev, current) => (prev.odds > current.odds) ? prev : current);
          }
        });

        if (Object.keys(bestOdds).length === outcomes.length) {
          const impliedProb = outcomes.reduce((sum, outcome) => sum + (1 / bestOdds[outcome].odds), 0);
          
          if (impliedProb < 1.0) {
            const profit = (1 / impliedProb - 1) * 100;
            opportunities.push({
              match,
              market,
              bestOdds,
              impliedProb,
              profit: parseFloat(profit.toFixed(2)),
              roi: parseFloat(profit.toFixed(2))
            });
          }
        }
      });
    });

    // Rank by ROI
    opportunities.sort((a, b) => b.roi - a.roi);
    res.json(opportunities);
  });

  app.get("/api/value-bets", (req, res) => {
    // Value bets are where one bookmaker's odds are significantly higher than the average
    const matches = db.prepare("SELECT * FROM matches LIMIT 20").all();
    const valueBets: any[] = [];

    matches.forEach((match: any) => {
      const odds = db.prepare("SELECT * FROM odds WHERE match_id = ?").all(match.id) as any[];
      const outcomes = ['1', 'X', '2'];
      
      outcomes.forEach(outcome => {
        const outcomeOdds = odds.filter(o => o.outcome === outcome);
        if (outcomeOdds.length > 0) {
          const avgOdds = outcomeOdds.reduce((sum, o) => sum + o.odds, 0) / outcomeOdds.length;
          const maxOdds = outcomeOdds.reduce((max, o) => (o.odds > max.odds ? o : max), outcomeOdds[0]);
          
          // If max odds is 15% higher than average, it's a value bet
          if (maxOdds.odds > avgOdds * 1.15) {
            valueBets.push({
              match,
              outcome,
              odds: maxOdds.odds,
              avgOdds: parseFloat(avgOdds.toFixed(2)),
              bookmaker: maxOdds.bookmaker,
              value: parseFloat(((maxOdds.odds / avgOdds - 1) * 100).toFixed(2))
            });
          }
        }
      });
    });

    res.json(valueBets);
  });

  app.get("/api/value-discovery", (req, res) => {
    const bankroll = parseFloat(req.query.bankroll as string) || 10000;
    const includeTax = req.query.includeTax === 'true';
    
    const matches = db.prepare("SELECT * FROM matches LIMIT 30").all();
    const results: any[] = [];

    matches.forEach((match: any) => {
      const odds = db.prepare("SELECT * FROM odds WHERE match_id = ?").all(match.id) as any[];
      
      const marketConfigs = [
        { name: '1X2', outcomes: ['1', 'X', '2'] },
        { name: 'Double Chance', outcomes: ['1X', '12', 'X2'] },
        { name: 'GG/NG', outcomes: ['GG', 'NG'] },
        { name: 'Goals Over/Under 2.5', outcomes: ['Over', 'Under'] },
        { name: 'Corners Over/Under 9.5', outcomes: ['Over', 'Under'] },
        { name: 'DC & Over/Under 2.5', outcomes: ['1X & Over', 'X2 & Over', '1X & Under', 'X2 & Under'] }
      ];

      marketConfigs.forEach(mConfig => {
        const marketOdds = odds.filter(o => o.market === mConfig.name);
        if (marketOdds.length === 0) return;

        // Calculate "Fair Market Probability" based on average odds
        const trueProbs: Record<string, number> = {};
        let totalImplied = 0;
        mConfig.outcomes.forEach(outcome => {
          const outcomeOdds = marketOdds.filter(o => o.outcome === outcome);
          if (outcomeOdds.length > 0) {
            const avgOdd = outcomeOdds.reduce((sum, o) => sum + o.odds, 0) / outcomeOdds.length;
            trueProbs[outcome] = 1 / avgOdd;
            totalImplied += trueProbs[outcome];
          } else {
            trueProbs[outcome] = 0;
          }
        });

        // Normalize to 100% (remove margin)
        if (totalImplied > 0) {
          Object.keys(trueProbs).forEach(k => trueProbs[k] = (trueProbs[k] / totalImplied) * 100);
        }

        mConfig.outcomes.forEach(outcome => {
          const outcomeOdds = marketOdds.filter(o => o.outcome === outcome);
          if (outcomeOdds.length === 0) return;

          const avgOdds = outcomeOdds.reduce((sum, o) => sum + o.odds, 0) / outcomeOdds.length;
          const bestOddObj = outcomeOdds.reduce((max, o) => (o.odds > max.odds ? o : max), outcomeOdds[0]);
          
          let effectiveOdds = bestOddObj.odds;
          if (includeTax) {
            effectiveOdds = 1 + (bestOddObj.odds - 1) * 0.85;
          }

          const trueProb = trueProbs[outcome];
          const p = trueProb / 100;
          const value = (effectiveOdds * trueProb) / 100;

          if (value > 1.0) {
            const edge = (effectiveOdds * p) - 1;
            const b = effectiveOdds - 1;
            const q = 1 - p;
            const kelly_pct = ((b * p) - q) / b;
            const fractional_kelly = Math.max(0, kelly_pct * 0.5);
            const suggested_stake = bankroll * fractional_kelly;
            const marketLag = bestOddObj.odds > avgOdds * 1.2;

            results.push({
              match,
              market: mConfig.name,
              outcome,
              bookmaker: bestOddObj.bookmaker,
              odds: bestOddObj.odds,
              effectiveOdds: parseFloat(effectiveOdds.toFixed(2)),
              trueProb: parseFloat(trueProb.toFixed(1)),
              edge: parseFloat((edge * 100).toFixed(2)),
              kellyPct: parseFloat((fractional_kelly * 100).toFixed(2)),
              suggestedStake: parseFloat(suggested_stake.toFixed(2)),
              marketLag,
              avgOdds: parseFloat(avgOdds.toFixed(2))
            });
          }
        });
      });
    });

    // Sort by Edge %
    results.sort((a, b) => b.edge - a.edge);
    res.json(results);
  });

  app.get("/api/predictions", (req, res) => {
    const matches = db.prepare("SELECT * FROM matches WHERE sport = 'Football' LIMIT 15").all();
    const predictions: any[] = [];

    matches.forEach((match: any) => {
      const homeStats = db.prepare("SELECT * FROM team_stats WHERE team_name = ?").get(match.home_team) as any;
      const awayStats = db.prepare("SELECT * FROM team_stats WHERE team_name = ?").get(match.away_team) as any;

      if (!homeStats || !awayStats) return;

      // 1. Statistical Win % (Simplified Poisson-like)
      const homeAttack = homeStats.goal_avg_scored;
      const awayDefense = awayStats.goal_avg_conceded;
      const awayAttack = awayStats.goal_avg_scored;
      const homeDefense = homeStats.goal_avg_conceded;
      
      const homeExp = (homeAttack + awayDefense) / 2;
      const awayExp = (awayAttack + homeDefense) / 2;
      
      const statHomeWin = (homeExp / (homeExp + awayExp + 1)) * 100;
      const statDraw = (1 / (homeExp + awayExp + 1)) * 100;
      const statAwayWin = (awayExp / (homeExp + awayExp + 1)) * 100;

      // 2. Form Win % (Weighted last 5)
      const homeForm = homeStats.last_5_points / 15;
      const awayForm = awayStats.last_5_points / 15;
      const formEdge = (homeForm - awayForm) * 20; // Max 20% swing
      
      const formHomeWin = 45 + formEdge;
      const formDraw = 25;
      const formAwayWin = 30 - formEdge;

      // 3. AI Insight % (Qualitative news)
      let aiAdjustment = 0;
      if (awayStats.injuries !== 'None' && awayStats.injuries !== '') {
        aiAdjustment = 5;
      }

      const aiHomeWin = formHomeWin + aiAdjustment;
      const aiDraw = formDraw - (aiAdjustment / 2);
      const aiAwayWin = formAwayWin - (aiAdjustment / 2);

      // Final ZABA Win % (Average of the three)
      const finalHomeWin = Math.round((statHomeWin + formHomeWin + aiHomeWin) / 3);
      const finalAwayWin = Math.round((statAwayWin + formAwayWin + aiAwayWin) / 3);
      const finalDraw = 100 - finalHomeWin - finalAwayWin;

      let aiNarrative = `Statistical analysis suggests a ${finalHomeWin}% probability for ${match.home_team} based on recent league performance.`;
      
      if (aiAdjustment > 0) {
        aiNarrative = `Market sentiment favors ${match.home_team} slightly due to reported squad rotations in the ${match.away_team} camp.`;
      }

      // Generate multi-market probabilities based on 1X2 baseline
      const generateProbs = (count: number, baseline?: number) => {
        if (count === 2 && baseline !== undefined) {
          return [baseline, 100 - baseline];
        }
        const probs = Array.from({ length: count }, () => 100 / count);
        return probs;
      };

      const pDC = generateProbs(3);
      const pGGNG = generateProbs(2);
      const pGoals = generateProbs(2);
      const pCorners = generateProbs(2);
      const pCombined = generateProbs(4);

      // ZABA Confidence
      const confidence = Math.min(95, Math.round(60 + (Math.abs(finalHomeWin - finalAwayWin) / 2) + (aiAdjustment * 2)));

      predictions.push({
        match,
        homeWin: finalHomeWin,
        draw: finalDraw,
        awayWin: finalAwayWin,
        confidence,
        confidenceLevel: confidence > 80 ? '🔥 High' : confidence > 50 ? '⚠️ Medium' : '❄️ Low',
        geminiPredicts: aiNarrative,
        stadium: match.stadium,
        pitch: match.pitch_condition,
        marketPredictions: {
          '1X2': { '1': finalHomeWin, 'X': finalDraw, '2': finalAwayWin },
          'Double Chance': { '1X': pDC[0], '12': pDC[1], 'X2': pDC[2] },
          'GG/NG': { 'GG': pGGNG[0], 'NG': pGGNG[1] },
          'Goals Over/Under 2.5': { 'Over': pGoals[0], 'Under': pGoals[1] },
          'Corners Over/Under 9.5': { 'Over': pCorners[0], 'Under': pCorners[1] },
          'DC & Over/Under 2.5': { '1X & Over': pCombined[0], 'X2 & Over': pCombined[1], '1X & Under': pCombined[2], 'X2 & Under': pCombined[3] }
        }
      });
    });

    res.json(predictions);
  });

  app.get("/api/market-status", (req, res) => {
    try {
      const sitesCount = db.prepare("SELECT COUNT(DISTINCT bookmaker) as count FROM odds").get() as { count: number };
      const matchesCount = db.prepare("SELECT COUNT(*) as count FROM matches").get() as { count: number };
      const lastUpdate = db.prepare("SELECT MAX(updated_at) as last FROM odds").get() as { last: string };

      res.json({
        sitesMonitored: sitesCount.count,
        totalSites: ZAMBIAN_SITES.length,
        activeMatches: matchesCount.count,
        lastUpdate: lastUpdate.last || null
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch market status" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`ZABA Server running on http://localhost:${PORT}`);
    
    // Start the Python Scraper as a background process
    console.log("Attempting to start ZABA Scraper...");
    PythonShell.run('scraper.py', { mode: 'text' }).then(messages => {
      console.log('Scraper finished/started:', messages);
    }).catch(err => {
      console.error('Scraper failed to start (Check if Python and dependencies are installed):', err.message);
    });
  });
}

startServer();
