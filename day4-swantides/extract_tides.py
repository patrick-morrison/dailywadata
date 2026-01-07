#!/usr/bin/env python3
"""
Extract tide data from BOM PDF tide charts.
Outputs JSON files for each location.
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

COLUMN_RANGES = [
    (30, 92), (92, 155), (155, 222), (222, 293),
    (293, 357), (357, 428), (428, 492), (492, 600)
]

PAGE_MAP = {
    1: [0, 1, 2, 3],
    2: [4, 5, 6, 7],
    3: [8, 9, 10, 11]
}


def get_column_index(x):
    for i, (min_x, max_x) in enumerate(COLUMN_RANGES):
        if min_x <= x < max_x:
            return i
    return -1


def parse_merged_text(text):
    """Handle merged text like 'TU1413' -> ['TU', '1413']."""
    match = re.match(r'^([A-Z]{2,3})(\d{4})$', text)
    if match:
        return [match.group(1), match.group(2)]
    return [text]


def extract_from_column(words, month_idx):
    words.sort(key=lambda w: (round(w['top']), w['x0']))
    
    entries = []
    current_day = None
    
    tokens_stream = []
    for w in words:
        for t in parse_merged_text(w['text']):
            tokens_stream.append({'text': t, 'top': w['top']})
    
    i = 0
    while i < len(tokens_stream):
        token = tokens_stream[i]['text']
        
        if token.isdigit() and len(token) <= 2 and 1 <= int(token) <= 31:
            current_day = int(token)
            i += 1
            continue
        
        if re.match(r'^\d{4}$', token):
            time_str = token
            if i + 1 < len(tokens_stream):
                next_token = tokens_stream[i+1]['text']
                try:
                    height = float(next_token)
                    if 0.0 <= height <= 2.5 and current_day is not None:
                        try:
                            d = date(YEAR, month_idx + 1, current_day)
                            entries.append({
                                'date': d.isoformat(),
                                'time': f"{time_str[:2]}:{time_str[2:]}",
                                'height': height
                            })
                        except ValueError:
                            pass
                    i += 2
                    continue
                except ValueError:
                    pass
        
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
            
            columns = defaultdict(list)
            for w in words:
                col_idx = get_column_index(w['x0'])
                if col_idx != -1:
                    columns[col_idx].append(w)
            
            for col_idx in range(8):
                offset = col_idx // 2
                if offset >= len(month_indices):
                    continue
                month_idx = month_indices[offset]
                all_entries.extend(extract_from_column(columns[col_idx], month_idx))

    return all_entries


def classify_tides(tides):
    tides.sort(key=lambda x: (x['date'], x['time']))
    
    for i in range(len(tides)):
        prev_h = tides[i-1]['height'] if i > 0 else tides[i]['height']
        next_h = tides[i+1]['height'] if i < len(tides)-1 else tides[i]['height']
        curr = tides[i]['height']
        
        if curr > prev_h and curr > next_h:
            tides[i]['type'] = 'high'
        elif curr < prev_h and curr < next_h:
            tides[i]['type'] = 'low'
        elif curr > 0.8:
            tides[i]['type'] = 'high'
        else:
            tides[i]['type'] = 'low'
    
    return tides


def validate_data(tides):
    issues = []
    
    unique_days = sorted(set(t['date'] for t in tides))
    if len(unique_days) != 365:
        issues.append(f"Day count: {len(unique_days)}/365")
        
        expected = set()
        d = date(YEAR, 1, 1)
        while d.year == YEAR:
            expected.add(d.isoformat())
            try:
                d = d.replace(day=d.day + 1)
            except ValueError:
                if d.month == 12:
                    break
                d = d.replace(month=d.month+1, day=1)
        
        missing = expected - set(unique_days)
        if missing:
            issues.append(f"Missing: {sorted(missing)[:3]}...")

    day_counts = defaultdict(int)
    for t in tides:
        day_counts[t['date']] += 1
    
    suspicious = [d for d, c in day_counts.items() if c < 1 or c > 4]
    if suspicious:
        issues.append(f"Suspicious counts on {len(suspicious)} days")

    return issues


def main():
    for loc in LOCATIONS:
        print(f"\n--- {loc['name']} ---")
        try:
            raw = extract_all(loc['pdf'])
            print(f"Extracted {len(raw)} entries")
            
            unique = {}
            for entry in raw:
                unique[f"{entry['date']}_{entry['time']}"] = entry
            
            data = classify_tides(list(unique.values()))
            issues = validate_data(data)
            
            if issues:
                print(f"⚠️  Issues: {', '.join(issues)}")
            else:
                print("✓ Valid")

            with open(loc['output'], 'w') as f:
                json.dump({
                    "location": loc['name'],
                    "year": YEAR,
                    "source": "Bureau of Meteorology",
                    "extracted": datetime.now().isoformat(),
                    "tides": data
                }, f, indent=2)
            print(f"→ {loc['output']}")
            
        except Exception as e:
            print(f"✗ Failed: {e}")


if __name__ == "__main__":
    main()
