#!/usr/bin/env python3
"""
Extract tide data from BOM Fremantle PDF for 2026.
Uses a robust column-centric approach to handle merged text and rigorous structure.
"""

import json
import re
import sys
from collections import defaultdict
from datetime import datetime, date

try:
    import pdfplumber
except ImportError:
    print("ERROR: pdfplumber required. Run: pip install pdfplumber")
    sys.exit(1)

LOCATIONS = [
    {"name": "Fremantle", "pdf": "IDO59001_2026_WA_TP015.pdf", "output": "tides_fremantle.json"},
    {"name": "Barrack Street", "pdf": "IDO59001_2026_WA_TP062.pdf", "output": "tides_barrack.json"}
]

YEAR = 2026
DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

# Valid x-ranges for the 8 columns on the page
# Based on visual inspection: 
# Col 0: 30-95
# Col 1: 95-165
# Col 2: 170-225
# Col 3: 225-295 
# Col 4: 295-360
# Col 5: 360-430
# Col 6: 430-495
# Col 7: 495-580
COLUMN_RANGES = [
    (30, 92),    # Col 0: Jan 1-15
    (92, 155),   # Col 1: Jan 16-31 (Ends ~141, Next starts ~167)
    (155, 222),  # Col 2: Feb 1-15 (Ends ~212, Next starts ~232)
    (222, 293),  # Col 3: Feb 16-31 (Ends ~277, Next starts ~310)
    (293, 357),  # Col 4: Mar 1-15 (Ends ~347, Next starts ~367)
    (357, 428),  # Col 5: Mar 16-31 (Ends ~412, Next starts ~445)
    (428, 492),  # Col 6: Apr 1-15 (Ends ~482, Next starts ~502)
    (492, 600),  # Col 7: Apr 16-31
]

# Map pages to the months they contain (0-indexed, so 0=Jan)
PAGE_MAP = {
    1: [0, 1, 2, 3],      # Page 2: Jan-Apr
    2: [4, 5, 6, 7],      # Page 3: May-Aug
    3: [8, 9, 10, 11]     # Page 4: Sep-Dec
}

def get_column_index(x):
    """Return 0-7 for the column index, or -1 if out of bounds."""
    for i, (min_x, max_x) in enumerate(COLUMN_RANGES):
        if min_x <= x < max_x:
            return i
    return -1

def clean_text(text):
    """Clean common OCR/PDF artifacts."""
    return text.strip()

def parse_merged_text(text):
    """
    Handle merged text like 'TU1413' or 'MO1243'.
    Returns a list of token strings.
    """
    # Regex to find embedded 4-digit times
    # This handles:
    # "TU1413" -> ["TU", "1413"]
    # "1413" -> ["1413"]
    # "1.12" -> ["1.12"]
    
    tokens = []
    
    # Check for Day+Time merge: "TU1413"
    day_time_match = re.match(r'^([A-Z]{2,3})(\d{4})$', text)
    if day_time_match:
        return [day_time_match.group(1), day_time_match.group(2)]
        
    return [text]

def extract_from_column(words, month_idx):
    """
    Process a list of words belonging to a single column (half-month).
    Returns a list of dicts: {'day': int, 'time': str, 'height': float}
    """
    # Sort words locally by Y (top)
    # Secondary sort by X to keep left-to-right reading order within lines
    words.sort(key=lambda w: (round(w['top']), w['x0']))
    
    entries = []
    current_day = None
    
    # State machine buffer
    # We might see: [DayNumber], [DayName], [Time], [Height]
    # or [DayNumber], [DayName, Time (merged)], [Height]
    
    # We iterate through resolved tokens
    tokens_stream = []
    for w in words:
        split_tokens = parse_merged_text(w['text'])
        for t in split_tokens:
            tokens_stream.append({'text': t, 'top': w['top']})
            
    i = 0
    while i < len(tokens_stream):
        token = tokens_stream[i]['text']
        
        # 1. Is it a Day Number?
        # Must be 1 or 2 digits to avoid confusing '0026' (Time) with Day 26
        if token.isdigit() and len(token) <= 2 and 1 <= int(token) <= 31:
            possible_day = int(token)
            # context check: next token shouldn't be a decimal (height) immediately without time
            current_day = possible_day
            i += 1
            continue
            
        # 2. Is it a Time? (HHMM)
        if re.match(r'^\d{4}$', token):
            time_str = token
            # Look ahead for height
            if i + 1 < len(tokens_stream):
                next_token = tokens_stream[i+1]['text']
                # Check if next token is a float (height)
                try:
                    height = float(next_token)
                    if 0.0 <= height <= 2.5: # Valid tide range
                        if current_day is not None:
                             try:
                                 # Validate date
                                 d = date(YEAR, month_idx + 1, current_day)
                                 entries.append({
                                     'date': d.isoformat(),
                                     'time': f"{time_str[:2]}:{time_str[2:]}",
                                     'height': height
                                 })
                             except ValueError:
                                 pass # Invalid date (e.g., Feb 30)
                        i += 2
                        continue
                except ValueError:
                    pass
        
        # 3. Skip noise (Day names like MON, TUE, 1.25 floating without time)
        i += 1
        
    return entries

def extract_all(pdf_file):
    print(f"Opening {pdf_file}...")
    all_entries = []
    
    with pdfplumber.open(pdf_file) as pdf:
        for page_idx, month_indices in PAGE_MAP.items():
            if page_idx >= len(pdf.pages):
                break
                
            print(f"Processing Page {page_idx + 1}...")
            page = pdf.pages[page_idx]
            words = page.extract_words()
            
            # Bin words into columns
            # columns[0..7] -> list of words
            columns = defaultdict(list)
            
            for w in words:
                col_idx = get_column_index(w['x0'])
                if col_idx != -1:
                    columns[col_idx].append(w)
            
            # Process each column
            for col_idx in range(8):
                # Map column to month
                # Pair 0,1 -> Month A (indices[0])
                # Pair 2,3 -> Month B (indices[1]) ...
                
                offset = col_idx // 2
                if offset >= len(month_indices): 
                    continue
                    
                month_idx = month_indices[offset] # 0-11
                
                col_entries = extract_from_column(columns[col_idx], month_idx)
                all_entries.extend(col_entries)

    return all_entries

def classify_tides(tides):
    """Mark high/low based on neighbors."""
    # Sort by overall time
    tides.sort(key=lambda x: (x['date'], x['time']))
    
    for i in range(len(tides)):
        prev_h = tides[i-1]['height'] if i > 0 else tides[i]['height']
        next_h = tides[i+1]['height'] if i < len(tides)-1 else tides[i]['height']
        curr = tides[i]['height']
        
        # Local extrema
        if curr > prev_h and curr > next_h:
            tides[i]['type'] = 'high'
        elif curr < prev_h and curr < next_h:
            tides[i]['type'] = 'low'
        # Fallback for edges or flat spots
        elif curr > 0.8:
            tides[i]['type'] = 'high'
        else:
            tides[i]['type'] = 'low'
            
    return tides

def validate_data(tides):
    """Aggressive validation."""
    issues = []
    
    # 1. Check Day Count
    unique_days = sorted(list(set(t['date'] for t in tides)))
    if len(unique_days) != 365:
        issues.append(f"Day count mismatch: Found {len(unique_days)}, expected 365")
        
        # Find missing
        expected_set = set()
        d = date(YEAR, 1, 1)
        while d.year == YEAR:
            expected_set.add(d.isoformat())
            try:
                d = d.replace(day=d.day + 1)
            except ValueError:
                if d.month == 12: d = d.replace(year=YEAR+1)
                else: d = d.replace(month=d.month+1, day=1)
                
        actual_set = set(unique_days)
        missing = expected_set - actual_set
        if missing:
            issues.append(f"Missing dates: {sorted(list(missing))[:5]}...")

    # 2. Check Tides per Day
    day_counts = defaultdict(int)
    for t in tides:
        day_counts[t['date']] += 1
    
    suspicious_days = [d for d, c in day_counts.items() if c < 1 or c > 4]
    if suspicious_days:
        issues.append(f"Suspicious tide counts (0 or >4) on {len(suspicious_days)} days: {suspicious_days[:3]}...")
    
    # Just warn for 1-tide days, don't fail
    one_tide_days = [d for d, c in day_counts.items() if c == 1]
    if one_tide_days:
        print(f"⚠️  Note: {len(one_tide_days)} days have only 1 tide (acceptable).")

    return issues

def main():
    for loc in LOCATIONS:
        print(f"\n--- Extracting {loc['name']} ---")
        try:
            raw_data = extract_all(loc['pdf'])
            print(f"Extracted {len(raw_data)} raw entries")
            
            # Deduplicate
            unique_map = {}
            for entry in raw_data:
                key = f"{entry['date']}_{entry['time']}"
                unique_map[key] = entry
            
            clean_data = list(unique_map.values())
            clean_data = classify_tides(clean_data)
            
            issues = validate_data(clean_data)
            
            if issues:
                print(f"\n❌ VALIDATION FAILED for {loc['name']}:")
                for i in issues:
                    print(f" - {i}")
            else:
                print(f"\n✅ VALIDATION PASSED for {loc['name']}: 365 Days.")

            output = {
                "location": loc['name'],
                "year": YEAR,
                "source": "Bureau of Meteorology",
                "extracted": datetime.now().isoformat(),
                "tides": clean_data
            }
            
            with open(loc['output'], 'w') as f:
                json.dump(output, f, indent=2)
            print(f"Saved to {loc['output']}")
            
        except Exception as e:
            print(f"FAILED to process {loc['name']}: {e}")

if __name__ == "__main__":
    main()
