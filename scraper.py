import requests
from bs4 import BeautifulSoup
import sqlite3
import time
import json
import logging
import random
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor

# Configure Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("scraper.log"),
        logging.StreamHandler()
    ]
)

DB_PATH = "zaba.db"

# List of Zambian Bookmakers to target
BOOKMAKERS = [
    "Betway Zambia", "1xBet Zambia", "Gal Sport Betting", "BetPawa Zambia",
    "PremierBet Zambia", "888bet Zambia", "Bolanet", "Yellow Bet",
    "M-Bet Zambia", "BetLion Zambia", "Odibets Zambia", "GSB Zambia",
    "Bwin Zambia", "Parimatch Zambia", "Melbet Zambia", "22Bet Zambia",
    "BetWinner Zambia", "MozzartBet Zambia", "Frapapa", "Merrybet",
    "NairaBet", "SportyBet", "Bet9ja", "CloudBet", "Stake.com",
    "Pinnacle", "SBOBET", "Bet365", "William Hill", "Betway International"
]

class ZABAScraper:
    def __init__(self, db_path=DB_PATH):
        self.db_path = db_path
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        })
        self.team_mapping = self._load_team_mappings()

    def _load_team_mappings(self):
        # In a real app, this would be a comprehensive JSON file or DB table
        return {
            "ZESCO Utd": "ZESCO United",
            "Power Dyn": "Power Dynamos",
            "Nkana": "Nkana FC",
            "Buffaloes": "Green Buffaloes",
            "Forest": "Forest Rangers",
            "Zanaco": "Zanaco FC",
            "Arrows": "Red Arrows",
            "Warriors": "Kabwe Warriors",
            "NAPSA": "NAPSA Stars",
            "Muf Wanderers": "Mufulira Wanderers"
        }

    def _get_canonical_name(self, name):
        return self.team_mapping.get(name, name)

    def connect_db(self):
        return sqlite3.connect(self.db_path)

    def update_odds(self, match_data, odds_data):
        """
        match_data: {home_team, away_team, league, sport, match_time}
        odds_data: [{bookmaker, market, outcome, odds}]
        """
        conn = self.connect_db()
        cursor = conn.cursor()
        
        home = self._get_canonical_name(match_data['home_team'])
        away = self._get_canonical_name(match_data['away_team'])

        try:
            # 1. Find or Create Match
            cursor.execute("""
                SELECT id FROM matches 
                WHERE home_team = ? AND away_team = ? AND league = ?
            """, (home, away, match_data['league']))
            
            match_row = cursor.fetchone()
            if match_row:
                match_id = match_row[0]
            else:
                cursor.execute("""
                    INSERT INTO matches (sport, league, home_team, away_team, match_time, stadium, pitch_condition)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (match_data['sport'], match_data['league'], home, away, match_data['match_time'], "Unknown", "Unknown"))
                match_id = cursor.lastrowid

            # 2. Insert/Update Odds
            for odd in odds_data:
                cursor.execute("""
                    INSERT INTO odds (match_id, bookmaker, market, outcome, odds, updated_at)
                    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(match_id, bookmaker, market, outcome) DO UPDATE SET
                    odds = excluded.odds,
                    updated_at = CURRENT_TIMESTAMP
                """, (match_id, odd['bookmaker'], odd['market'], odd['outcome'], odd['odds']))

            conn.commit()
        except Exception as e:
            logging.error(f"Database error: {e}")
            conn.rollback()
        finally:
            conn.close()

    def scrape_betway(self):
        """Implementation for Betway Zambia"""
        logging.info("Scraping Betway Zambia...")
        # Note: In production, this would use site-specific selectors or API endpoints
        # Example of how to structure the real scraping logic:
        try:
            # url = "https://www.betway.co.zm/api/v1/events/..."
            # response = self.session.get(url)
            # if response.status_code == 200:
            #     data = response.json()
            #     # Parse data and call self.update_odds(...)
            pass
        except Exception as e:
            logging.error(f"Error scraping Betway: {e}")

    def scrape_generic_bookie(self, bookmaker_name):
        """Generic scraper template for other bookmakers"""
        logging.info(f"Scraping {bookmaker_name}...")
        # This would use site-specific selectors or API endpoints
        pass

    def run_cycle(self):
        logging.info("Starting scraping cycle...")
        
        # Parallel scraping for efficiency
        with ThreadPoolExecutor(max_workers=5) as executor:
            executor.submit(self.scrape_betway)
            for bookie in BOOKMAKERS[1:5]: # Limit for demo
                executor.submit(self.scrape_generic_bookie, bookie)
        
        logging.info("Scraping cycle completed.")

if __name__ == "__main__":
    scraper = ZABAScraper()
    
    # Continuous loop with sleep
    while True:
        try:
            scraper.run_cycle()
            # Sleep for 5 minutes between cycles
            logging.info("Sleeping for 300 seconds...")
            time.sleep(300)
        except KeyboardInterrupt:
            logging.info("Scraper stopped by user.")
            break
        except Exception as e:
            logging.error(f"Critical error in main loop: {e}")
            time.sleep(60)
